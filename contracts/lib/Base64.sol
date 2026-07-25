// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Base64
 * @notice Minimal base64 encoder, for building data-URI token metadata on chain.
 *
 * Why not OpenZeppelin's: its version reaches `Bytes.sol`, which uses the
 * `mcopy` opcode from the Cancun upgrade. This project compiles for `paris` on
 * purpose, so the bytecode stays deployable on the Subnet-EVM versions CSB
 * actually runs. Pulling in the dependency would mean raising the EVM target for
 * every contract in the repository to get one helper — so the helper is here
 * instead.
 *
 * This is the widely-used reference implementation (Brecht Devos, MIT), which
 * predates `mcopy` and needs nothing beyond the base instruction set.
 */
library Base64 {
    string internal constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function encode(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";

        // Output is 4 characters per 3 input bytes, rounded up.
        string memory table = TABLE;
        string memory result = new string(4 * ((data.length + 2) / 3));

        assembly {
            let tablePtr := add(table, 1)
            let resultPtr := add(result, 32)

            for {
                let dataPtr := data
                let endPtr := add(data, mload(data))
            } lt(dataPtr, endPtr) {} {
                dataPtr := add(dataPtr, 3)
                let input := mload(dataPtr)

                mstore8(resultPtr, mload(add(tablePtr, and(shr(18, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(12, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(6, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(input, 0x3F))))
                resultPtr := add(resultPtr, 1)
            }

            // Pad the final group with '=' so decoders accept it.
            switch mod(mload(data), 3)
            case 1 {
                mstore8(sub(resultPtr, 1), 0x3d)
                mstore8(sub(resultPtr, 2), 0x3d)
            }
            case 2 { mstore8(sub(resultPtr, 1), 0x3d) }
        }

        return result;
    }
}
