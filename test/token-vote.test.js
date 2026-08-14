const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySuite } = require("./fixtures");

/**
 * TokenVote is the DAO product: one contract, many DAOs, any ERC-20 on the chain
 * as the voting weight.
 *
 * Three properties carry the whole thing, and each is a way it would silently be
 * wrong rather than visibly broken:
 *
 *   ESCROW STOPS DOUBLE VOTING. Weighing by balanceOf at vote time is defeated by
 *   voting, moving the tokens, and voting again from the second address. The
 *   tokens are locked instead, so they are not in hand to move.
 *
 *   WEIGHT IS WHAT ARRIVED, NOT WHAT WAS ASKED FOR. KHRt takes a levy on
 *   transfer. Crediting the requested amount would promise withdrawals this
 *   contract cannot honour, and the shortfall would land on whoever withdrew
 *   last — the failure appears far from its cause.
 *
 *   A TIE IS A TIE. Handing it to the lowest index would dress an arbitrary rule
 *   as an outcome.
 */
describe("TokenVote", function () {
  let vote, khr, identity, council, idAuthority, issuer, alice, bob, carol;

  const DAY = 24 * 60 * 60;

  async function newDao(opts = {}) {
    const tx = await vote.createDao(
      opts.name ?? "Growers",
      opts.token ?? (await khr.getAddress()),
      opts.weighing ?? 0,                       // 0 = Escrow, 1 = Snapshot
      opts.quorumBps ?? 0,
      opts.period ?? DAY,
      opts.minPropose ?? 0);
    await tx.wait();
    return Number(await vote.daoCount()) - 1;
  }
  async function newProposal(daoId, choices = ["Yes", "No"]) {
    await (await vote.propose(daoId, "Build the dryer", "Shared maize dryer.", choices)).wait();
    return Number(await vote.proposalCount()) - 1;
  }

  beforeEach(async function () {
    // The suite gives distinct signers per power on purpose, so a test that
    // needs the issuer cannot quietly pass by using a super-admin.
    const st = await deploySuite();
    khr = st.khr; identity = st.identity;
    council = st.council; idAuthority = st.idAuthority; issuer = st.issuer;
    alice = st.alice; bob = st.bob; carol = st.outsider;

    vote = await (await ethers.getContractFactory("TokenVote")).deploy();

    // KHRt only moves between attested parties, and the voting contract has to
    // HOLD it to escrow a vote. That is the same problem the Uniswap pool hit
    // (docs/defi.md), and it has the same answer.
    await (await khr.connect(council).setSystemContract(await vote.getAddress(), true)).wait();

    for (const [who, amount] of [[alice, 1000_00n], [bob, 400_00n], [carol, 600_00n]]) {
      await (await identity.connect(idAuthority)
        .register(who.address, ethers.id("voter-" + who.address), 2)).wait();
      await (await khr.connect(issuer).issue(who.address, amount)).wait();
    }
  });

  it("creates a DAO as a storage record, not a deployment", async function () {
    const rc = await (await vote.createDao("Growers", await khr.getAddress(), 0, 0, DAY, 0)).wait();
    // The point of the whole design: a user without contract-deployer rights can
    // do this. If it ever costs deployment-scale gas, it has become a factory.
    expect(rc.gasUsed).to.be.lessThan(250_000n);
    const d = await vote.daoAt(0);
    expect(d.name).to.equal("Growers");
    expect(d.token).to.equal(await khr.getAddress());
  });

  it("refuses a token that is not a contract", async function () {
    await expect(vote.createDao("X", alice.address, 0, 0, DAY, 0))
      .to.be.revertedWithCustomError(vote, "NotAContract");
  });

  it("refuses a voting period too short to participate in", async function () {
    await expect(vote.createDao("X", await khr.getAddress(), 0, 0, 60, 0))
      .to.be.revertedWithCustomError(vote, "BadPeriod");
  });

  it("refuses fewer than two choices", async function () {
    const dao = await newDao();
    await expect(vote.propose(dao, "t", "b", ["Only one"]))
      .to.be.revertedWithCustomError(vote, "BadChoices");
  });

  it("enforces the DAO's own proposal threshold", async function () {
    const dao = await newDao({ minPropose: 500_00n });
    await expect(vote.connect(bob).propose(dao, "t", "b", ["Yes", "No"]))
      .to.be.revertedWithCustomError(vote, "BelowProposeThreshold");
    await expect(vote.connect(alice).propose(dao, "t", "b", ["Yes", "No"])).to.not.be.reverted;
  });

  describe("voting", function () {
    let dao, prop;
    beforeEach(async function () {
      dao = await newDao();
      prop = await newProposal(dao);
    });

    it("locks the tokens and counts them as weight", async function () {
      await (await khr.connect(alice).approve(await vote.getAddress(), 100_00n)).wait();
      const before = await khr.balanceOf(alice.address);
      await (await vote.connect(alice).vote(prop, 0, 100_00n)).wait();

      expect(await khr.balanceOf(alice.address)).to.equal(before - 100_00n);
      expect(await khr.balanceOf(await vote.getAddress())).to.equal(100_00n);
      expect((await vote.weightsOf(prop))[0]).to.equal(100_00n);
    });

    it("refuses a second vote from the same address", async function () {
      await (await khr.connect(alice).approve(await vote.getAddress(), 200_00n)).wait();
      await (await vote.connect(alice).vote(prop, 0, 100_00n)).wait();
      await expect(vote.connect(alice).vote(prop, 1, 100_00n))
        .to.be.revertedWithCustomError(vote, "AlreadyVoted");
    });

    it("stops the same tokens voting twice from a second address", async function () {
      // The attack escrow exists to prevent: vote, move the tokens to a fresh
      // address, vote again. Alice commits her ENTIRE balance, so what is left
      // to move is exactly nothing — which is the property, stated as a balance
      // rather than as a hopeful revert.
      const all = await khr.balanceOf(alice.address);
      await (await khr.connect(alice).approve(await vote.getAddress(), all)).wait();
      await (await vote.connect(alice).vote(prop, 0, all)).wait();

      expect(await khr.balanceOf(alice.address)).to.equal(0n);
      await expect(khr.connect(alice).transfer(carol.address, 1n)).to.be.reverted;
      expect((await vote.weightsOf(prop))[0]).to.equal(all);

      // And carol, who was never given them, cannot vote them either.
      await (await khr.connect(carol).approve(await vote.getAddress(), all)).wait();
      await expect(vote.connect(carol).vote(prop, 1, all)).to.be.reverted;
    });

    it("refuses a choice that does not exist", async function () {
      await (await khr.connect(alice).approve(await vote.getAddress(), 100_00n)).wait();
      await expect(vote.connect(alice).vote(prop, 5, 100_00n))
        .to.be.revertedWithCustomError(vote, "BadChoice");
    });

    it("refuses a vote after the clock runs out", async function () {
      await (await khr.connect(alice).approve(await vote.getAddress(), 100_00n)).wait();
      await time.increase(DAY + 1);
      await expect(vote.connect(alice).vote(prop, 0, 100_00n))
        .to.be.revertedWithCustomError(vote, "NotOpen");
    });

    it("credits the amount RECEIVED when the token charges a levy", async function () {
      // 1 riel per transfer, paid by the sender. The contract must not credit
      // weight it does not hold.
      await (await khr.connect(council).setTransferLevy(1_00n, council.address)).wait();
      await (await khr.connect(council).setSystemContract(await vote.getAddress(), false)).wait();
      await (await identity.connect(idAuthority).register(await vote.getAddress(), ethers.id("tokenvote"), 3)).wait();

      await (await khr.connect(alice).approve(await vote.getAddress(), 100_00n)).wait();
      await (await vote.connect(alice).vote(prop, 0, 100_00n)).wait();

      const held = await khr.balanceOf(await vote.getAddress());
      const credited = (await vote.weightsOf(prop))[0];
      expect(credited).to.equal(held);
      expect(credited).to.be.lessThan(100_00n);   // the levy really was taken

      // And the withdrawal is honourable, because it was never overpromised.
      await time.increase(DAY + 1);
      await expect(vote.connect(alice).withdraw(prop)).to.not.be.reverted;
    });
  });

  describe("closing", function () {
    let dao, prop;
    beforeEach(async function () {
      dao = await newDao();
      prop = await newProposal(dao);
    });

    it("will not close while the vote is open", async function () {
      await expect(vote.close(prop)).to.be.revertedWithCustomError(vote, "StillOpen");
    });

    it("picks the heaviest choice, and anyone may settle it", async function () {
      await (await khr.connect(alice).approve(await vote.getAddress(), 300_00n)).wait();
      await (await khr.connect(bob).approve(await vote.getAddress(), 100_00n)).wait();
      await (await vote.connect(alice).vote(prop, 0, 300_00n)).wait();
      await (await vote.connect(bob).vote(prop, 1, 100_00n)).wait();

      await time.increase(DAY + 1);
      await (await vote.connect(carol).close(prop)).wait();   // not the proposer
      const p = await vote.proposalAt(prop);
      expect(p.closed).to.equal(true);
      expect(p.winner).to.equal(0);
      expect(p.tied).to.equal(false);
      expect(p.totalWeight).to.equal(400_00n);
    });

    it("reports a tie as a tie rather than picking one", async function () {
      await (await khr.connect(alice).approve(await vote.getAddress(), 100_00n)).wait();
      await (await khr.connect(bob).approve(await vote.getAddress(), 100_00n)).wait();
      await (await vote.connect(alice).vote(prop, 0, 100_00n)).wait();
      await (await vote.connect(bob).vote(prop, 1, 100_00n)).wait();

      await time.increase(DAY + 1);
      await (await vote.close(prop)).wait();
      const p = await vote.proposalAt(prop);
      expect(p.tied).to.equal(true);
      expect(p.winner).to.equal(255);            // NO_RESULT
    });

    it("records no result when quorum is not reached", async function () {
      const strict = await newDao({ quorumBps: 9000 });   // 90% of supply must vote
      const p2 = await newProposal(strict);
      await (await khr.connect(alice).approve(await vote.getAddress(), 100_00n)).wait();
      await (await vote.connect(alice).vote(p2, 0, 100_00n)).wait();

      await time.increase(DAY + 1);
      await (await vote.close(p2)).wait();
      const p = await vote.proposalAt(p2);
      expect(p.closed).to.equal(true);
      expect(p.winner).to.equal(255);
      expect(p.tied).to.equal(false);            // not a tie — nobody turned up
    });

    it("cannot be closed twice", async function () {
      await time.increase(DAY + 1);
      await (await vote.close(prop)).wait();
      await expect(vote.close(prop)).to.be.revertedWithCustomError(vote, "AlreadyClosed");
    });
  });

  describe("withdrawing", function () {
    let dao, prop;
    beforeEach(async function () {
      dao = await newDao();
      prop = await newProposal(dao);
      await (await khr.connect(alice).approve(await vote.getAddress(), 100_00n)).wait();
      await (await vote.connect(alice).vote(prop, 0, 100_00n)).wait();
    });

    it("refuses while the vote is open", async function () {
      await expect(vote.connect(alice).withdraw(prop))
        .to.be.revertedWithCustomError(vote, "StillOpen");
    });

    it("returns the locked tokens without waiting for anyone to close it", async function () {
      // Tokens must not be hostage to somebody else sending a transaction.
      await time.increase(DAY + 1);
      const before = await khr.balanceOf(alice.address);
      await (await vote.connect(alice).withdraw(prop)).wait();
      expect(await khr.balanceOf(alice.address)).to.equal(before + 100_00n);
      expect((await vote.proposalAt(prop)).closed).to.equal(false);
    });

    it("cannot be drained twice", async function () {
      await time.increase(DAY + 1);
      await (await vote.connect(alice).withdraw(prop)).wait();
      await expect(vote.connect(alice).withdraw(prop))
        .to.be.revertedWithCustomError(vote, "NothingToWithdraw");
    });

    it("gives nothing to someone who never voted", async function () {
      await time.increase(DAY + 1);
      await expect(vote.connect(bob).withdraw(prop))
        .to.be.revertedWithCustomError(vote, "NothingToWithdraw");
    });

    it("leaves the recorded result untouched", async function () {
      await time.increase(DAY + 1);
      await (await vote.close(prop)).wait();
      await (await vote.connect(alice).withdraw(prop)).wait();
      // Withdrawing returns the stake; it does not retract the vote.
      expect((await vote.weightsOf(prop))[0]).to.equal(100_00n);
      expect((await vote.proposalAt(prop)).winner).to.equal(0);
    });
  });

  describe("snapshot weighing", function () {
    let mvt;

    beforeEach(async function () {
      mvt = await (await ethers.getContractFactory("MockVotesToken")).deploy();
      for (const [who, amt] of [[alice, 1000n], [bob, 400n], [carol, 600n]]) {
        await (await mvt.mint(who.address, amt)).wait();
      }
    });

    it("refuses a snapshot DAO on a token that keeps no checkpoints", async function () {
      // Caught at creation, not at the first vote. Silently falling back to
      // escrow would lock tokens somebody was told they would keep.
      await expect(vote.createDao("X", await khr.getAddress(), 1, 0, DAY, 0))
        .to.be.revertedWithCustomError(vote, "NotCheckpointed");
      expect(await vote.isCheckpointed(await khr.getAddress())).to.equal(false);
      expect(await vote.isCheckpointed(await mvt.getAddress())).to.equal(true);
    });

    it("weighs by past holdings and locks nothing", async function () {
      const dao = await newDao({ token: await mvt.getAddress(), weighing: 1 });
      const prop = await newProposal(dao);

      const before = await mvt.balanceOf(alice.address);
      await (await vote.connect(alice).vote(prop, 0, 0)).wait();   // no amount, no approval

      expect(await mvt.balanceOf(alice.address)).to.equal(before);      // nothing moved
      expect(await mvt.balanceOf(await vote.getAddress())).to.equal(0n); // nothing escrowed
      expect((await vote.weightsOf(prop))[0]).to.equal(1000n);
    });

    it("ignores tokens acquired after the snapshot", async function () {
      const dao = await newDao({ token: await mvt.getAddress(), weighing: 1 });
      const prop = await newProposal(dao);
      await (await mvt.mint(bob.address, 10_000n)).wait();   // after the snapshot block

      await (await vote.connect(bob).vote(prop, 1, 0)).wait();
      expect((await vote.weightsOf(prop))[1]).to.equal(400n);   // his holding at the snapshot
    });

    it("stops the same tokens voting twice from a second address", async function () {
      // The attack snapshots exist to prevent, with nothing locked: vote, send
      // the tokens on, vote again from the address that now holds them.
      const dao = await newDao({ token: await mvt.getAddress(), weighing: 1 });
      const prop = await newProposal(dao);

      await (await vote.connect(alice).vote(prop, 0, 0)).wait();
      await (await mvt.connect(alice).transfer(carol.address, 1000n)).wait();

      // Carol holds them now, but held 600 at the snapshot — she votes that, not
      // alice's thousand, and the total cannot exceed what existed.
      await (await vote.connect(carol).vote(prop, 1, 0)).wait();
      expect((await vote.weightsOf(prop))[1]).to.equal(600n);
      expect((await vote.proposalAt(prop)).totalWeight).to.equal(1600n);
    });

    it("refuses a voter who held nothing at the snapshot", async function () {
      const dao = await newDao({ token: await mvt.getAddress(), weighing: 1 });
      const prop = await newProposal(dao);
      const [, , , , , , , stranger] = await ethers.getSigners();
      await expect(vote.connect(stranger).vote(prop, 0, 0))
        .to.be.revertedWithCustomError(vote, "NoWeight");
    });

    it("has nothing to withdraw, and says so", async function () {
      const dao = await newDao({ token: await mvt.getAddress(), weighing: 1 });
      const prop = await newProposal(dao);
      await (await vote.connect(alice).vote(prop, 0, 0)).wait();
      await time.increase(DAY + 1);
      await expect(vote.connect(alice).withdraw(prop))
        .to.be.revertedWithCustomError(vote, "NoEscrowToWithdraw");
    });

    it("measures quorum against the supply at the snapshot, not after it", async function () {
      // Minting after a vote opens must not raise the bar retroactively and
      // defeat a proposal that had already passed.
      const dao = await newDao({ token: await mvt.getAddress(), weighing: 1, quorumBps: 5000 });
      const prop = await newProposal(dao);           // supply at snapshot: 2000
      await (await vote.connect(alice).vote(prop, 0, 0)).wait();   // 1000 = exactly 50%

      await (await mvt.mint(bob.address, 1_000_000n)).wait();      // would sink it if counted
      await time.increase(DAY + 1);
      await (await vote.close(prop)).wait();

      const p = await vote.proposalAt(prop);
      expect(p.winner).to.equal(0);                  // carried, as it should have
    });
  });

  it("summarises a proposal in one call, for the list view", async function () {
    const dao = await newDao({ name: "Growers" });
    const prop = await newProposal(dao, ["Yes", "No", "Later"]);
    const s = await vote.summaryOf(prop);
    expect(s.daoName).to.equal("Growers");
    expect(s.choices.length).to.equal(3);
    expect(s.weights.length).to.equal(3);
    expect(s.token).to.equal(await khr.getAddress());
  });
});
