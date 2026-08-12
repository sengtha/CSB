// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * A scope guard for a Safe wallet: it decides what the wallet may call at all,
 * independently of who signed.
 *
 * WHY, GIVEN THERE IS ALREADY A THRESHOLD. A threshold answers "did enough
 * owners agree". It cannot answer "agree to what", and it is exactly as strong
 * as the owners' ability to read what they are signing. A multisig removes the
 * single key and, in exchange, widens the phishing surface: there are now
 * several people to deceive. This bounds the damage when that works — a quorum
 * tricked into signing a transfer to an attacker cannot execute it if the
 * attacker's address was never allow-listed.
 *
 * THE TENSION THIS CONTRACT EXISTS TO RESOLVE. A guard that a quorum can remove
 * in one transaction bounds nothing: the same signatures that authorise the
 * theft can authorise removing the guard first. A guard that cannot be removed
 * bricks the wallet the first time the policy is wrong — permanently, with
 * whatever is inside it. Both failures are worse than no guard.
 *
 * So the rule here is ASYMMETRIC, which is the whole design:
 *
 *   TIGHTENING is immediate.  disallow() takes effect in the same transaction.
 *                             An emergency must never wait on a timer.
 *   LOOSENING is announced.   allow(), allowTarget() and removing the guard
 *                             require announce() plus a cooldown. A compromised
 *                             quorum cannot widen its own permissions and use
 *                             them in one sitting; it has to declare the intent
 *                             on chain and wait, which is the window in which
 *                             somebody notices.
 *
 * The cooldown is therefore the security property, not the allow list. An
 * allow list with no delay is a speed bump; a delay with no allow list has
 * nothing to delay.
 *
 * DELEGATECALL IS ALWAYS REFUSED. It runs the target's code against the
 * wallet's own storage and can rewrite its owners outright, which would make
 * every other rule here decorative. A wallet that genuinely needs it should not
 * have a guard.
 *
 * Interface note: Safe's setGuard() requires ERC-165 and checks the Guard
 * interface id, so both are implemented. The Guard interface is declared here
 * rather than imported — the Safe artifacts live in vendor/safe outside the
 * root node_modules, and the signatures are what the id is computed from, so a
 * local declaration with identical signatures produces an identical id.
 */

enum Operation { Call, DelegateCall }

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IGuard is IERC165 {
    function checkTransaction(
        address to,
        uint256 value,
        bytes memory data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures,
        address msgSender
    ) external;

    function checkAfterExecution(bytes32 hash, bool success) external;
}

contract SafeScopeGuard is IGuard {
    /// The wallet this guards. Immutable: a guard that could be repointed at
    /// another wallet would let one wallet's policy be administered by another.
    address public immutable safe;

    /// How long a loosening change must be announced before it can be applied.
    uint256 public immutable cooldown;

    /// keccak256(target, selector) => allowed
    mapping(bytes32 => bool) public allowedCall;
    /// target => every function on it is allowed, including plain transfers
    mapping(address => bool) public allowedTarget;

    /// action hash => the timestamp it was announced at (0 = not announced)
    mapping(bytes32 => uint256) public announcedAt;

    /// Removing the guard is an action like any other, with a fixed name.
    bytes32 public constant UNGUARD = keccak256("SafeScopeGuard:unguard");

    /// Safe's setGuard(address). Recognised so removal can be gated.
    bytes4 private constant SET_GUARD = bytes4(keccak256("setGuard(address)"));

    event Allowed(address indexed target, bytes4 indexed selector);
    event AllowedTarget(address indexed target);
    event Disallowed(address indexed target, bytes4 indexed selector);
    event DisallowedTarget(address indexed target);
    event Announced(bytes32 indexed action, uint256 executableAt);
    event AnnouncementCleared(bytes32 indexed action);

    error OnlySafe();
    error NotAnnounced(bytes32 action);
    error StillCooling(bytes32 action, uint256 executableAt);
    error DelegateCallRefused();
    error CallNotAllowed(address target, bytes4 selector);

    /// Only the wallet itself administers its own policy — which in practice
    /// means a quorum of its owners, through execTransaction.
    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe();
        _;
    }

    constructor(address _safe, uint256 _cooldown) {
        safe = _safe;
        cooldown = _cooldown;
    }

    // ------------------------------------------------------------------ policy

    /**
     * Declare an intent to loosen. The action hash is opaque on purpose: it is
     * whatever the corresponding call computes, so an announcement authorises
     * one specific widening and not a class of them.
     */
    function announce(bytes32 action) external onlySafe {
        announcedAt[action] = block.timestamp;
        emit Announced(action, block.timestamp + cooldown);
    }

    /// Withdraw an announcement. Tightening, so immediate.
    function cancelAnnouncement(bytes32 action) external onlySafe {
        delete announcedAt[action];
        emit AnnouncementCleared(action);
    }

    function allowKey(address target, bytes4 selector) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(target, selector));
    }

    function allow(address target, bytes4 selector) external onlySafe {
        bytes32 key = allowKey(target, selector);
        _consume(key);
        allowedCall[key] = true;
        emit Allowed(target, selector);
    }

    function allowTarget(address target) external onlySafe {
        bytes32 key = keccak256(abi.encodePacked("target", target));
        _consume(key);
        allowedTarget[target] = true;
        emit AllowedTarget(target);
    }

    // Tightening: no announcement, no waiting. If a permission turns out to be
    // wrong the wallet must be able to close it in the same breath as noticing.
    function disallow(address target, bytes4 selector) external onlySafe {
        delete allowedCall[allowKey(target, selector)];
        emit Disallowed(target, selector);
    }

    function disallowTarget(address target) external onlySafe {
        delete allowedTarget[target];
        emit DisallowedTarget(target);
    }

    /// An announcement is single-use: spent when the change it authorised lands.
    function _consume(bytes32 action) private {
        uint256 at = announcedAt[action];
        if (at == 0) revert NotAnnounced(action);
        if (block.timestamp < at + cooldown) revert StillCooling(action, at + cooldown);
        delete announcedAt[action];
    }

    // ------------------------------------------------------------------- guard

    /**
     * Called by the Safe before it executes. Reverting here stops the
     * transaction no matter how many owners signed it.
     */
    function checkTransaction(
        address to,
        uint256,
        bytes memory data,
        Operation operation,
        uint256,
        uint256,
        uint256,
        address,
        address payable,
        bytes memory,
        address
    ) external view override {
        if (operation == Operation.DelegateCall) revert DelegateCallRefused();

        bytes4 selector = data.length >= 4
            ? bytes4(data[0]) | (bytes4(data[1]) >> 8) | (bytes4(data[2]) >> 16) | (bytes4(data[3]) >> 24)
            : bytes4(0);

        // Administering this guard is always permitted. It is onlySafe-gated and
        // every loosening path inside it is already delayed, so allowing the
        // call adds no power — while forbidding it would make the policy
        // unchangeable, which is the brick.
        if (to == address(this)) return;

        if (to == safe) {
            // Removing the guard is the one call that could undo everything
            // else, so it is gated on an announcement that anyone watching the
            // chain can see, and on the cooldown elapsing.
            if (selector == SET_GUARD) {
                uint256 at = announcedAt[UNGUARD];
                if (at == 0) revert NotAnnounced(UNGUARD);
                if (block.timestamp < at + cooldown) revert StillCooling(UNGUARD, at + cooldown);
                return;
            }
            // Everything else the wallet does to itself — changing owners, the
            // threshold, modules — is ordinary policy and must be allow-listed.
        }

        if (allowedTarget[to]) return;
        if (data.length == 0) revert CallNotAllowed(to, bytes4(0)); // plain value transfer
        if (!allowedCall[allowKey(to, selector)]) revert CallNotAllowed(to, selector);
    }

    /// Nothing to check afterwards; the policy is entirely pre-execution.
    function checkAfterExecution(bytes32, bool) external override {}

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IGuard).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }
}
