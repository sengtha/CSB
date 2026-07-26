const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Grove — the digital twin's chain half.
 *
 * The scenario runs end to end: a farmer records a mangrove planting on her
 * phone (Grove signs it), anchors the record's hash on CSB, a licensed commune
 * agriculture officer goes and looks and confirms it, the grove becomes a title
 * whose supply IS the verified living-tree count, and a sponsor's money is
 * released only when a fresh confirmed record shows the trees are still there.
 *
 * The refusals are the point throughout. Almost every test below is a way of
 * getting paid for trees that are not standing, and the chain saying no.
 */
describe("Grove — anchored records, licensed verifiers, and survival-based pledges", function () {
  const KHR = (n) => BigInt(Math.round(n * 100)); // KHRt has 2 decimals
  const PLOT = ethers.id("plot/peam-krasop/mangrove-01");
  const OTHER_PLOT = ethers.id("plot/kampot/pepper-02");
  const SPECIES = ethers.encodeBytes32String("rhizophora");
  const LICENCE = ethers.id("licence/agri-officer/2026-0042");
  const NOTE = ethers.id("field-note/2026-07-20");
  const YEAR = 365 * 24 * 3600;

  // Stand-ins for Grove's SHA-256 observation ids. In production these are the
  // content hash of the canonically-serialised signed record; here any distinct
  // 32-byte value behaves identically, because the chain deliberately never
  // looks inside the record.
  const OBS = (n) => ethers.id(`observation-${n}`);

  async function deploy() {
    const [council, authority, enforcer, issuer, registrar, groveAuthority, arbiter, farmer, officer, ngo, sponsor, stranger] =
      await ethers.getSigners();

    const identity = await ethers.deployContract("IdentityRegistry", [council.address, authority.address]);
    const enforcement = await ethers.deployContract("EnforcementRegistry", [council.address, enforcer.address]);
    const khr = await ethers.deployContract("KHRStablecoin", [
      identity.target, enforcement.target, council.address, issuer.address,
    ]);
    const attesters = await ethers.deployContract("AttesterRegistry", [council.address, registrar.address]);
    const anchor = await ethers.deployContract("GroveAnchor", [
      identity.target, enforcement.target, attesters.target, council.address,
    ]);
    const registry = await ethers.deployContract("GroveTitleRegistry", [
      identity.target, enforcement.target, anchor.target, council.address, groveAuthority.address,
    ]);
    const pledge = await ethers.deployContract("GrovePledge", [
      anchor.target, council.address, arbiter.address,
    ]);

    // The anchor writes verifier reputation back to the licensing registry.
    await attesters.connect(council).grantRole(await attesters.RECORDER_ROLE(), anchor.target);

    // Tier 1 is enough to record your own garden; a grower is not a business.
    await identity.connect(authority).register(farmer.address, ethers.id("id-farmer"), 1);
    await identity.connect(authority).register(officer.address, ethers.id("id-officer"), 2);
    await identity.connect(authority).register(ngo.address, ethers.id("id-ngo"), 3);
    await identity.connect(authority).register(sponsor.address, ethers.id("id-sponsor"), 3);
    await identity.connect(authority).register(issuer.address, ethers.id("id-issuer"), 4);
    // `stranger` is deliberately never registered.

    await attesters.connect(registrar).licenseAttester(
      officer.address, await attesters.COMMUNE(), LICENCE, "Commune agriculture officer, Peam Krasop",
    );
    await attesters.connect(registrar).licenseAttester(
      ngo.address, await attesters.NGO(), ethers.id("licence/ngo/2026-0007"), "Mangrove Action NGO",
    );

    // The pledge custodies KHRt with no personal identity of its own, so the
    // council vets it exactly as it vets the escrow and the bridge adapter.
    await khr.connect(council).setSystemContract(pledge.target, true);
    await khr.connect(issuer).issue(sponsor.address, KHR(10_000_000));

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    return {
      council, authority, enforcer, issuer, registrar, groveAuthority, arbiter,
      farmer, officer, ngo, sponsor, stranger,
      identity, enforcement, khr, attesters, anchor, registry, pledge, now,
    };
  }

  /** Anchor a record and have the commune officer confirm it. */
  async function anchorAndConfirm(f, id, count, prev = ethers.ZeroHash, who = f.farmer) {
    await f.anchor.connect(who).anchor(id, PLOT, prev, count, SPECIES);
    await f.anchor.connect(f.officer).attest(id, true, NOTE);
    return id;
  }

  // ======================================================== 1. anchoring

  describe("Anchoring — an independent clock over a self-reported record", function () {
    it("stamps a record with consensus time, not the phone's clock", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);

      const a = await f.anchor.anchorOf(OBS(1));
      const block = await ethers.provider.getBlock("latest");
      expect(a.anchoredAt).to.equal(block.timestamp);
      expect(a.anchoredBy).to.equal(f.farmer.address);
      expect(a.plotId).to.equal(PLOT);
      expect(a.liveCount).to.equal(500);
      expect(await f.anchor.isAnchored(OBS(1))).to.equal(true);
      expect(await f.anchor.plotHead(PLOT)).to.equal(OBS(1));
      expect(await f.anchor.plotSteward(PLOT)).to.equal(f.farmer.address);
    });

    it("stores only the hash — no coordinates, no device key, no photo", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      // The whole struct, enumerated: nothing here can locate a garden or name
      // a person. A farmer's fruit trees are worth stealing.
      const a = await f.anchor.anchorOf(OBS(1));
      expect(Object.keys(a.toObject())).to.have.members([
        "plotId", "prevId", "species", "anchoredBy", "anchoredAt", "liveCount",
        "confirms", "disputes", "firstConfirmer",
      ]);
    });

    it("refuses the same record twice — the id is the content", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      await expect(f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES))
        .to.be.revertedWithCustomError(f.anchor, "AlreadyAnchored");
    });

    it("refuses an address the identity layer does not know", async function () {
      const f = await deploy();
      await expect(f.anchor.connect(f.stranger).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES))
        .to.be.revertedWithCustomError(f.anchor, "NotVerifiedIdentity");
    });

    it("refuses an account frozen by an enforcement order", async function () {
      const f = await deploy();
      await f.enforcement.connect(f.enforcer).freeze(f.farmer.address, ethers.id("order-2026-9"));
      await expect(f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES))
        .to.be.revertedWithCustomError(f.anchor, "AccountFrozen");
    });

    it("keeps one history per plot — a chain cannot fork", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      await f.anchor.connect(f.farmer).anchor(OBS(2), PLOT, OBS(1), 480, SPECIES);

      // A second branch off the older record: two histories of one garden, so
      // whichever is more flattering can be shown later.
      await expect(f.anchor.connect(f.farmer).anchor(OBS(3), PLOT, OBS(1), 500, SPECIES))
        .to.be.revertedWithCustomError(f.anchor, "PrevNotHead");
      expect(await f.anchor.plotHead(PLOT)).to.equal(OBS(2));
      expect(await f.anchor.plotLength(PLOT)).to.equal(2);
    });

    it("refuses a first record that claims a predecessor", async function () {
      const f = await deploy();
      await expect(f.anchor.connect(f.farmer).anchor(OBS(2), PLOT, OBS(1), 500, SPECIES))
        .to.be.revertedWithCustomError(f.anchor, "PrevNotHead");
    });

    it("will not let a stranger extend somebody else's garden history", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      await expect(f.anchor.connect(f.ngo).anchor(OBS(2), PLOT, OBS(1), 9000, SPECIES))
        .to.be.revertedWithCustomError(f.anchor, "NotPlotRecorder");
    });

    it("lets the steward add a second recorder — a spare phone, a co-op tablet", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      await f.anchor.connect(f.farmer).setPlotRecorder(PLOT, f.ngo.address, true);
      await f.anchor.connect(f.ngo).anchor(OBS(2), PLOT, OBS(1), 505, SPECIES);
      expect(await f.anchor.plotHead(PLOT)).to.equal(OBS(2));
    });

    it("only the steward may appoint a recorder", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      await expect(f.anchor.connect(f.ngo).setPlotRecorder(PLOT, f.ngo.address, true))
        .to.be.revertedWithCustomError(f.anchor, "NotPlotSteward");
    });

    it("explains a refusal before anyone signs", async function () {
      const f = await deploy();
      const [ok, reason] = await f.anchor.canAnchor(f.stranger.address);
      expect(ok).to.equal(false);
      expect(reason).to.contain("no active KYC attestation");
      expect((await f.anchor.canAnchor(f.farmer.address))[0]).to.equal(true);
    });
  });

  // ====================================================== 2. attestation

  describe("Attestation — a licence somebody can lose", function () {
    it("counts a licensed officer's confirmation, and marks the record verified", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      expect(await f.anchor.isVerified(OBS(1))).to.equal(false);

      await f.anchor.connect(f.officer).attest(OBS(1), true, NOTE);
      expect(await f.anchor.isVerified(OBS(1))).to.equal(true);
      const a = await f.anchor.anchorOf(OBS(1));
      expect(a.confirms).to.equal(1);
      expect(a.firstConfirmer).to.equal(f.officer.address);
      expect(await f.anchor.verifiedCountOf(PLOT)).to.equal(500);
    });

    it("ignores an address with no field-verifier licence — Sybil keys buy nothing", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      await expect(f.anchor.connect(f.sponsor).attest(OBS(1), true, NOTE))
        .to.be.revertedWithCustomError(f.anchor, "NotLicensedAttester");
      expect(await f.anchor.isVerified(OBS(1))).to.equal(false);
    });

    it("refuses self-attestation — you cannot verify your own trees", async function () {
      const f = await deploy();
      // Even a licensed verifier, recording their own grove.
      await f.anchor.connect(f.officer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      await expect(f.anchor.connect(f.officer).attest(OBS(1), true, NOTE))
        .to.be.revertedWithCustomError(f.anchor, "SelfAttestation");
    });

    it("refuses a suspended licence, at the moment of attesting", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      await f.attesters.connect(f.registrar).setSuspended(f.officer.address, true);
      await expect(f.anchor.connect(f.officer).attest(OBS(1), true, NOTE))
        .to.be.revertedWithCustomError(f.anchor, "NotLicensedAttester");
    });

    it("refuses a verifier frozen by an enforcement order", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      await f.enforcement.connect(f.enforcer).freeze(f.officer.address, ethers.id("order-2026-1"));
      await expect(f.anchor.connect(f.officer).attest(OBS(1), true, NOTE))
        .to.be.revertedWithCustomError(f.anchor, "AccountFrozen");
    });

    it("refuses the same verifier twice", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      await f.anchor.connect(f.officer).attest(OBS(1), true, NOTE);
      await expect(f.anchor.connect(f.officer).attest(OBS(1), true, NOTE))
        .to.be.revertedWithCustomError(f.anchor, "AlreadyAttested");
    });

    it("withholds verification when a licensed verifier disputes, even against a confirmation", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      await f.anchor.connect(f.officer).attest(OBS(1), true, NOTE);
      expect(await f.anchor.isVerified(OBS(1))).to.equal(true);

      // "These trees are not there." Somebody staked a licence on saying so;
      // the answer is a human going to look, not arithmetic outvoting them.
      await f.anchor.connect(f.ngo).attest(OBS(1), false, ethers.id("dispute/2026-3"));
      expect(await f.anchor.isVerified(OBS(1))).to.equal(false);
      expect(await f.anchor.verifiedCountOf(PLOT)).to.equal(0);
    });

    it("can demand more than one verifier when the council raises the bar", async function () {
      const f = await deploy();
      await f.anchor.connect(f.council).setRequiredConfirmations(2);
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      await f.anchor.connect(f.officer).attest(OBS(1), true, NOTE);
      expect(await f.anchor.isVerified(OBS(1))).to.equal(false);
      await f.anchor.connect(f.ngo).attest(OBS(1), true, NOTE);
      expect(await f.anchor.isVerified(OBS(1))).to.equal(true);
    });

    it("records the verifier's work against their licence, not their own say-so", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      await f.anchor.connect(f.officer).attest(OBS(1), true, NOTE);
      expect((await f.attesters.attesterOf(f.officer.address)).confirmations).to.equal(1);
      // A verifier cannot write their own reputation.
      await expect(f.attesters.connect(f.officer).recordWork(f.officer.address, true))
        .to.be.revertedWithCustomError(f.attesters, "AccessControlUnauthorizedAccount");
    });

    it("explains every attestation refusal in words", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      expect((await f.anchor.canAttest(f.sponsor.address, OBS(1)))[1]).to.contain("no current field-verifier licence");
      expect((await f.anchor.canAttest(f.farmer.address, OBS(1)))[1]).to.contain("cannot be verified by the person");
      expect((await f.anchor.canAttest(f.officer.address, OBS(9)))[1]).to.contain("has not been anchored");
      expect((await f.anchor.canAttest(f.officer.address, OBS(1)))[0]).to.equal(true);
    });
  });

  // =========================================================== 3. title

  describe("Grove title — supply the registrar cannot choose", function () {
    async function registerGrove(f, over = {}) {
      const tx = await f.registry.connect(f.groveAuthority).registerGrove({
        plotId: over.plotId ?? PLOT,
        name: "Peam Krasop Mangrove Grove",
        symbol: "GROVE01",
        location: "Peam Krasop, Koh Kong",
        groveURI: "grove://plot/peam-krasop/mangrove-01",
        minimumTier: 1,
        steward: over.steward ?? f.farmer.address,
      });
      const rc = await tx.wait();
      const ev = rc.logs
        .map((l) => { try { return f.registry.interface.parseLog(l); } catch { return null; } })
        .find((e) => e?.name === "GroveRegistered");
      return ethers.getContractAt("GroveTitle", ev.args.token);
    }

    it("cannot issue a title for a grove nobody has verified", async function () {
      const f = await deploy();
      await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
      // Anchored, but no licensed verifier has been near it.
      await expect(registerGrove(f)).to.be.revertedWithCustomError(f.registry, "NoVerifiedRecord");
    });

    it("cannot issue a title around somebody else's records", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      await expect(registerGrove(f, { steward: f.ngo.address }))
        .to.be.revertedWithCustomError(f.registry, "NotThePlotSteward");
    });

    it("only the grove authority may bring a grove on chain", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      await expect(f.registry.connect(f.farmer).registerGrove({
        plotId: PLOT, name: "x", symbol: "X", location: "", groveURI: "",
        minimumTier: 1, steward: f.farmer.address,
      })).to.be.revertedWithCustomError(f.registry, "AccessControlUnauthorizedAccount");
    });

    it("mints exactly the verified living-tree count — one share, one tree", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const title = await registerGrove(f);

      expect(await title.totalSupply()).to.equal(500n);
      expect(await title.balanceOf(f.farmer.address)).to.equal(500n);
      expect(await title.decimals()).to.equal(0);
      expect(await title.plotId()).to.equal(PLOT);
      expect(await f.registry.isRegisteredTitle(title.target)).to.equal(true);
    });

    it("grows as the verified grove grows, and anyone can force the correction", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const title = await registerGrove(f);

      await anchorAndConfirm(f, OBS(2), 620, OBS(1));
      // A sceptic, not the registrar, brings the ledger up to date.
      await f.registry.connect(f.sponsor).syncSupply(PLOT);
      expect(await title.totalSupply()).to.equal(620n);
    });

    it("SHRINKS when the trees die — a green asset that can lose value", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const title = await registerGrove(f);

      // A dry season and a salinity spike. 180 of them are gone.
      await anchorAndConfirm(f, OBS(2), 320, OBS(1));
      await f.registry.connect(f.sponsor).syncSupply(PLOT);
      expect(await title.totalSupply()).to.equal(320n);
      expect(await title.balanceOf(f.farmer.address)).to.equal(320n);
    });

    it("will not zero a grower's holding just because the newest record is unverified", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const title = await registerGrove(f);

      // A new record nobody has attested to yet is not evidence of nothing.
      await f.anchor.connect(f.farmer).anchor(OBS(2), PLOT, OBS(1), 700, SPECIES);
      await expect(f.registry.syncSupply(PLOT)).to.be.revertedWithCustomError(f.registry, "NoVerifiedRecord");
      expect(await title.totalSupply()).to.equal(500n);

      const [supply, count, inSync, reason] = await f.registry.supplyStatus(PLOT);
      expect(supply).to.equal(500n);
      expect(count).to.equal(0);
      expect(inSync).to.equal(false);
      expect(reason).to.contain("not verified by a licensed attester");
    });

    it("says plainly when shares sold on have put the ledger beyond its reach", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const title = await registerGrove(f);
      await title.connect(f.farmer).transfer(f.ngo.address, 400n);

      await anchorAndConfirm(f, OBS(2), 50, OBS(1)); // 450 trees died
      await expect(f.registry.syncSupply(PLOT)).to.be.revertedWithCustomError(f.registry, "SupplyDriftUnresolved");
      expect((await f.registry.supplyStatus(PLOT))[3]).to.contain("sold on");
    });

    it("refuses to settle with an address the identity layer does not know", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const title = await registerGrove(f);
      await expect(title.connect(f.farmer).transfer(f.stranger.address, 1n))
        .to.be.revertedWithCustomError(title, "NotVerified");
      expect((await title.canTransfer(f.farmer.address, f.stranger.address, 1n))[1])
        .to.contain("no active KYC attestation");
    });

    it("reports in sync when the token matches the verified record", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      await registerGrove(f);
      const [supply, count, inSync] = await f.registry.supplyStatus(PLOT);
      expect(supply).to.equal(500n);
      expect(count).to.equal(500);
      expect(inSync).to.equal(true);
    });

    it("keeps supply authority with the mechanism, not with the registrar", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const title = await registerGrove(f);
      const AGENT = await title.AGENT_ROLE();
      // Only the registry holds the mint key, and its only mint path reads the
      // anchor. There is no call in this system that mints an unverified tree.
      expect(await title.hasRole(AGENT, f.registry.target)).to.equal(true);
      expect(await title.hasRole(AGENT, f.groveAuthority.address)).to.equal(false);
      await expect(title.connect(f.groveAuthority).mint(f.groveAuthority.address, 1_000_000n))
        .to.be.revertedWithCustomError(title, "AccessControlUnauthorizedAccount");
    });
  });

  // ========================================================== 4. pledge

  describe("Pledge — money that only moves when the tree is still alive", function () {
    /** 500 mangroves: 12-month and 24-month survival milestones. */
    function terms(f, over = {}) {
      const y1 = over.y1 ?? f.now + YEAR;
      const y2 = over.y2 ?? f.now + 2 * YEAR;
      return [
        {
          notBefore: y1, deadline: y1 + 90 * 24 * 3600,
          requiredCount: over.required1 ?? 400,
          growerAmount: KHR(600_000), verifierAmount: KHR(50_000),
        },
        {
          notBefore: y2, deadline: y2 + 90 * 24 * 3600,
          requiredCount: over.required2 ?? 350,
          growerAmount: KHR(900_000), verifierAmount: KHR(50_000),
        },
      ];
    }

    async function pledged(f, over = {}) {
      await f.pledge.connect(f.sponsor).createPledge(
        over.plotId ?? PLOT, f.farmer.address, f.khr.target,
        "500 mangroves, Peam Krasop — 24-month survival", terms(f, over),
      );
      const id = Number(await f.pledge.pledgeCount());
      const p = await f.pledge.pledgeOf(id);
      await f.khr.connect(f.sponsor).approve(f.pledge.target, p.total);
      await f.pledge.connect(f.sponsor).fund(id);
      return id;
    }

    /** Move the chain to `when` and mine. */
    async function warpTo(when) {
      await ethers.provider.send("evm_setNextBlockTimestamp", [when]);
      await ethers.provider.send("evm_mine", []);
    }

    it("derives the total from the milestones, so they cannot disagree", async function () {
      const f = await deploy();
      const id = await pledged(f);
      const p = await f.pledge.pledgeOf(id);
      expect(p.total).to.equal(KHR(600_000) + KHR(50_000) + KHR(900_000) + KHR(50_000));
      expect(p.status).to.equal(2n); // Funded
      expect(await f.khr.balanceOf(f.pledge.target)).to.equal(p.total);
      expect(await f.pledge.milestoneCount(id)).to.equal(2);
    });

    it("pays the grower AND the verifier who went and looked", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500); // planting record
      const id = await pledged(f);

      await warpTo(f.now + YEAR + 60);
      // A fresh record, one year on: 430 still standing, confirmed in the field.
      await anchorAndConfirm(f, OBS(2), 430, OBS(1));

      const growerBefore = await f.khr.balanceOf(f.farmer.address);
      const officerBefore = await f.khr.balanceOf(f.officer.address);
      await f.pledge.connect(f.farmer).claimMilestone(id, 0, OBS(2));

      expect((await f.khr.balanceOf(f.farmer.address)) - growerBefore).to.equal(KHR(600_000));
      expect((await f.khr.balanceOf(f.officer.address)) - officerBefore).to.equal(KHR(50_000));
      const m = await f.pledge.milestoneOf(id, 0);
      expect(m.status).to.equal(1n); // Paid
      expect(m.provedBy).to.equal(OBS(2));
      expect(m.paidVerifier).to.equal(f.officer.address);
    });

    it("refuses last year's photograph as proof of this year's survival", async function () {
      const f = await deploy();
      // A healthy record made TODAY, before the milestone window opens.
      await anchorAndConfirm(f, OBS(1), 500);
      const id = await pledged(f);

      await warpTo(f.now + YEAR + 60);
      await expect(f.pledge.claimMilestone(id, 0, OBS(1)))
        .to.be.revertedWithCustomError(f.pledge, "ProofTooOld");
      expect((await f.pledge.canClaim(id, 0, OBS(1)))[1]).to.contain("predates the milestone");
    });

    it("refuses a record no licensed verifier has confirmed", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const id = await pledged(f);

      await warpTo(f.now + YEAR + 60);
      await f.anchor.connect(f.farmer).anchor(OBS(2), PLOT, OBS(1), 430, SPECIES); // unattested
      await expect(f.pledge.claimMilestone(id, 0, OBS(2)))
        .to.be.revertedWithCustomError(f.pledge, "ProofNotVerified");
      expect((await f.pledge.canClaim(id, 0, OBS(2)))[1]).to.contain("no licensed field verifier");
    });

    it("refuses a disputed record", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const id = await pledged(f);

      await warpTo(f.now + YEAR + 60);
      await anchorAndConfirm(f, OBS(2), 430, OBS(1));
      await f.anchor.connect(f.ngo).attest(OBS(2), false, ethers.id("dispute/mangrove"));
      await expect(f.pledge.claimMilestone(id, 0, OBS(2)))
        .to.be.revertedWithCustomError(f.pledge, "ProofNotVerified");
    });

    it("refuses when fewer trees are standing than were promised", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const id = await pledged(f);

      await warpTo(f.now + YEAR + 60);
      await anchorAndConfirm(f, OBS(2), 120, OBS(1)); // needed 400
      await expect(f.pledge.claimMilestone(id, 0, OBS(2)))
        .to.be.revertedWithCustomError(f.pledge, "NotEnoughTrees");
      expect((await f.pledge.canClaim(id, 0, OBS(2)))[1]).to.contain("fewer trees are still standing");
    });

    it("refuses proof borrowed from a different grove", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const id = await pledged(f);

      await warpTo(f.now + YEAR + 60);
      // A thriving grove — somebody else's.
      await f.anchor.connect(f.ngo).anchor(OBS(7), OTHER_PLOT, ethers.ZeroHash, 900, SPECIES);
      await f.anchor.connect(f.officer).attest(OBS(7), true, NOTE);
      await expect(f.pledge.claimMilestone(id, 0, OBS(7)))
        .to.be.revertedWithCustomError(f.pledge, "ProofFromAnotherPlot");
    });

    it("refuses a claim before the survival window opens", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const id = await pledged(f);
      await expect(f.pledge.claimMilestone(id, 0, OBS(1)))
        .to.be.revertedWithCustomError(f.pledge, "WindowNotOpen");
      expect((await f.pledge.canClaim(id, 0, OBS(1)))[1]).to.contain("window has not opened");
    });

    it("cannot be claimed twice", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const id = await pledged(f);
      await warpTo(f.now + YEAR + 60);
      await anchorAndConfirm(f, OBS(2), 430, OBS(1));
      await f.pledge.claimMilestone(id, 0, OBS(2));
      await expect(f.pledge.claimMilestone(id, 0, OBS(2)))
        .to.be.revertedWithCustomError(f.pledge, "WrongMilestoneStatus");
    });

    it("returns an unproved milestone to the sponsor after the deadline", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const id = await pledged(f);
      const before = await f.khr.balanceOf(f.sponsor.address);

      await warpTo(f.now + YEAR + 91 * 24 * 3600);
      await f.pledge.connect(f.sponsor).reclaimExpired(id, 0);
      expect((await f.khr.balanceOf(f.sponsor.address)) - before).to.equal(KHR(600_000) + KHR(50_000));
      expect((await f.pledge.milestoneOf(id, 0)).status).to.equal(2n); // Reclaimed
    });

    it("will not let the sponsor reclaim before the deadline", async function () {
      const f = await deploy();
      const id = await pledged(f);
      await expect(f.pledge.connect(f.sponsor).reclaimExpired(id, 0))
        .to.be.revertedWithCustomError(f.pledge, "DeadlineNotReached");
    });

    it("only the sponsor may reclaim their own money", async function () {
      const f = await deploy();
      const id = await pledged(f);
      await warpTo(f.now + YEAR + 91 * 24 * 3600);
      await expect(f.pledge.connect(f.farmer).reclaimExpired(id, 0))
        .to.be.revertedWithCustomError(f.pledge, "NotSponsor");
    });

    it("does not suspend compliance: a frozen grower reverts the whole settlement", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const id = await pledged(f);
      await warpTo(f.now + YEAR + 60);
      await anchorAndConfirm(f, OBS(2), 430, OBS(1));

      await f.enforcement.connect(f.enforcer).freeze(f.farmer.address, ethers.id("order-2026-77"));
      await expect(f.pledge.claimMilestone(id, 0, OBS(2))).to.be.reverted;
      // Not even the verifier is paid — an enforcement freeze outranks the
      // commercial obligation rather than being routed around.
      expect(await f.khr.balanceOf(f.officer.address)).to.equal(0n);
      expect(await f.khr.balanceOf(f.pledge.target)).to.equal((await f.pledge.pledgeOf(id)).total);
    });

    it("closes the pledge once every milestone is settled", async function () {
      const f = await deploy();
      await anchorAndConfirm(f, OBS(1), 500);
      const id = await pledged(f);

      await warpTo(f.now + YEAR + 60);
      await anchorAndConfirm(f, OBS(2), 430, OBS(1));
      await f.pledge.claimMilestone(id, 0, OBS(2));

      await warpTo(f.now + 2 * YEAR + 60);
      await anchorAndConfirm(f, OBS(3), 390, OBS(2));
      await f.pledge.claimMilestone(id, 1, OBS(3));

      const p = await f.pledge.pledgeOf(id);
      expect(p.status).to.equal(3n); // Closed
      expect(p.remaining).to.equal(0n);
      expect(await f.khr.balanceOf(f.pledge.target)).to.equal(0n);
    });

    it("lets an arbiter settle when the proof exists but the chain cannot see it", async function () {
      const f = await deploy();
      const id = await pledged(f);
      const before = await f.khr.balanceOf(f.farmer.address);
      await f.pledge.connect(f.arbiter).releaseByArbiter(id, 0, ethers.id("case/flooded-road"));
      // No verifier on the record, so their share follows the work that was
      // actually done — an arbiter must never get to name a payee.
      expect((await f.khr.balanceOf(f.farmer.address)) - before).to.equal(KHR(600_000) + KHR(50_000));
    });

    it("lets an arbiter return a milestone when the grove is gone", async function () {
      const f = await deploy();
      const id = await pledged(f);
      const before = await f.khr.balanceOf(f.sponsor.address);
      await f.pledge.connect(f.arbiter).refundByArbiter(id, 0, ethers.id("case/cleared-for-road"));
      expect((await f.khr.balanceOf(f.sponsor.address)) - before).to.equal(KHR(600_000) + KHR(50_000));
    });

    it("requires a recorded reason for every arbiter decision", async function () {
      const f = await deploy();
      const id = await pledged(f);
      await expect(f.pledge.connect(f.arbiter).releaseByArbiter(id, 0, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.pledge, "ReasonRequired");
    });

    it("keeps arbiter powers away from everyone else", async function () {
      const f = await deploy();
      const id = await pledged(f);
      await expect(f.pledge.connect(f.sponsor).releaseByArbiter(id, 0, ethers.id("x")))
        .to.be.revertedWithCustomError(f.pledge, "AccessControlUnauthorizedAccount");
    });

    it("refuses milestones that run backwards", async function () {
      const f = await deploy();
      const bad = terms(f);
      bad[1].notBefore = f.now + 100; // before milestone 0's deadline
      await expect(f.pledge.connect(f.sponsor).createPledge(PLOT, f.farmer.address, f.khr.target, "x", bad))
        .to.be.revertedWithCustomError(f.pledge, "MilestonesOutOfOrder");
    });

    it("will not pay out of an unfunded pledge", async function () {
      const f = await deploy();
      await f.pledge.connect(f.sponsor).createPledge(
        PLOT, f.farmer.address, f.khr.target, "unfunded", terms(f),
      );
      const id = Number(await f.pledge.pledgeCount());
      expect((await f.pledge.canClaim(id, 0, OBS(1)))[1]).to.contain("not funded");
    });
  });

  // ================================================== 5. the whole story

  it("end to end: plant, anchor, verify, tokenize, and get paid for survival", async function () {
    const f = await deploy();

    // 1. A farmer plants 500 mangroves and records it on her phone. The record
    //    is signed on-device; only its hash comes here.
    await f.anchor.connect(f.farmer).anchor(OBS(1), PLOT, ethers.ZeroHash, 500, SPECIES);
    // 2. The commune agriculture officer visits and confirms it.
    await f.anchor.connect(f.officer).attest(OBS(1), true, NOTE);
    expect(await f.anchor.verifiedCountOf(PLOT)).to.equal(500);

    // 3. The grove becomes a title. 500 verified trees, 500 shares.
    const tx = await f.registry.connect(f.groveAuthority).registerGrove({
      plotId: PLOT, name: "Peam Krasop Mangrove Grove", symbol: "GROVE01",
      location: "Peam Krasop, Koh Kong", groveURI: "grove://plot/peam-krasop/mangrove-01",
      minimumTier: 1, steward: f.farmer.address,
    });
    const rc = await tx.wait();
    const token = rc.logs.map((l) => { try { return f.registry.interface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "GroveRegistered").args.token;
    const title = await ethers.getContractAt("GroveTitle", token);
    expect(await title.totalSupply()).to.equal(500n);

    // 4. A sponsor abroad funds survival, not planting.
    const y1 = f.now + YEAR;
    await f.pledge.connect(f.sponsor).createPledge(
      PLOT, f.farmer.address, f.khr.target, "500 mangroves, 12-month survival",
      [{
        notBefore: y1, deadline: y1 + 90 * 24 * 3600, requiredCount: 400,
        growerAmount: KHR(600_000), verifierAmount: KHR(50_000),
      }],
    );
    const id = Number(await f.pledge.pledgeCount());
    await f.khr.connect(f.sponsor).approve(f.pledge.target, (await f.pledge.pledgeOf(id)).total);
    await f.pledge.connect(f.sponsor).fund(id);

    // 5. A year passes. 430 are still standing; the officer confirms again.
    await ethers.provider.send("evm_setNextBlockTimestamp", [y1 + 60]);
    await ethers.provider.send("evm_mine", []);
    await f.anchor.connect(f.farmer).anchor(OBS(2), PLOT, OBS(1), 430, SPECIES);
    await f.anchor.connect(f.officer).attest(OBS(2), true, NOTE);

    // 6. The money moves, and the twin's tree count follows the real grove down
    //    from 500 to 430 — because 70 of them died, and the ledger says so.
    await f.pledge.claimMilestone(id, 0, OBS(2));
    await f.registry.syncSupply(PLOT);

    expect(await f.khr.balanceOf(f.farmer.address)).to.equal(KHR(600_000));
    expect(await f.khr.balanceOf(f.officer.address)).to.equal(KHR(50_000));
    expect(await title.totalSupply()).to.equal(430n);
    expect(await f.registry.supplyStatus(PLOT)).to.deep.equal([430n, 430n, true, ""]);
  });
});
