# Staking write coverage on the devnet

The SDK has 19 staking writes. This file records, for each one, whether the devnet tier runs it and, if not, why. Every write, run or not, also has its calldata pinned by unit ground truth in `packages/maticjs/tests/unit/staking-calldata-ground-truth.test.ts`. That test proves the SDK encodes the right function and arguments. Only a devnet run proves the write lands on a real StakeManager deployment.

Verdicts:

- **RUNS**: the write is broadcast and confirmed on the devnet through all three adapters (viem, ethers v5, ethers v6), and its effect is read back through the SDK.
- **GATED**: the write is not broadcast on the devnet, for the reason given. Calldata ground truth still covers it.

Every staking write in this tier passes the devnet's L1 chain id as `chainId`. The SDK pins staking writes to the network's L1 (Ethereum or Sepolia) by default, and the devnet is neither. The one exception is the wrong-chain row in `staking-writes.e2e.test.ts`. It leaves `chainId` out on purpose and checks that the write is refused with `UNSUPPORTED_NETWORK` and that the account's nonce does not move, so nothing was broadcast.

## The 19 writes

| Write | Verdict | Where | Reason when gated | Calldata ground truth |
|---|---|---|---|---|
| `approveStakeManager` | RUNS | `staking-writes.e2e.test.ts` (POL and MATIC rows, wrong-chain row); `staking-delegation.e2e.test.ts` | | `pol.prepareApproveStakeManager`, `matic.prepareApproveStakeManager` |
| `approveMaxForStakeManager` | RUNS | `staking-writes.e2e.test.ts` | | `pol.prepareApproveMaxForStakeManager`, `matic.prepareApproveMaxForStakeManager` |
| `delegate` | RUNS | `staking-delegation.e2e.test.ts` | | `validatorShare.prepareDelegate` |
| `delegateMatic` | GATED | none | The devnet StakeManager has been migrated to POL (`initializePOL`), and the tier exercises the POL delegation path. Legacy MATIC delegation (`buyVoucher`) is not broadcast, so whether it lands on a migrated deployment is not checked here. | `validatorShare.prepareDelegateMatic` |
| `delegateWithPermit` | RUNS | `staking-delegation.e2e.test.ts` | The typed data is signed over a domain the test builds (`name: 'POL'`, `version: '1'`, the devnet chain id, the POL address). The test first checks that domain against the token's on-chain `DOMAIN_SEPARATOR`. The SDK's own `preparePermit` cannot be used here; see below. | `validatorShare.prepareDelegateWithPermit`, `pol.preparePermit` |
| `undelegate` | RUNS | `staking-delegation.e2e.test.ts` | | `validatorShare.prepareUndelegate` |
| `claimUndelegated` | RUNS | `staking-delegation.e2e.test.ts` | | `validatorShare.prepareClaimUndelegated` |
| `restakeRewards` | RUNS | `staking-delegation.e2e.test.ts` | | `validatorShare.prepareRestakeRewards` |
| `withdrawRewards` | RUNS | `staking-delegation.e2e.test.ts` | | `validatorShare.prepareWithdrawRewards` |
| `stakeFor` | GATED | `staking-validator.e2e.test.ts` (skipped) | Registers a second validator with no node behind it. On the single-validator devnet this halts block production: heimdall's producer selection fails ("no candidates found"), bor stops, and checkpoints stop. Observed on kurtosis-pos v1.4.8: L2 stopped about 60 s after `stakeFor` and did not recover in 6 minutes. A halted devnet fails every other test sharing it, so `stakeFor` never runs in a suite. | `stakeManager.prepareStakeFor` |
| `stakeForMatic` | GATED | none | As `stakeFor`, and it is the legacy MATIC path on a StakeManager migrated to POL. | `stakeManager.prepareStakeForMatic` |
| `restake` | GATED | `staking-validator.e2e.test.ts` (skipped) | Needs a validator the test owns, which needs `stakeFor` (gated). | `stakeManager.prepareRestake` |
| `withdrawValidatorRewards` | GATED | `staking-validator.e2e.test.ts` (skipped) | Needs a validator the test owns, which needs `stakeFor` (gated). | `stakeManager.prepareWithdrawValidatorRewards` |
| `topUpHeimdallFee` | GATED | `staking-validator.e2e.test.ts` (skipped) | Needs a validator the test owns, which needs `stakeFor` (gated). | `stakeManager.prepareTopUpHeimdallFee` |
| `unstake` | GATED | `staking-validator.e2e.test.ts` (skipped) | Needs a validator the test owns, which needs `stakeFor` (gated). The devnet's own validator signs every checkpoint, so unstaking it would stop the devnet. | `stakeManager.prepareUnstake` |
| `claimUnstaked` | GATED | `staking-validator.e2e.test.ts` (skipped) | Follows `unstake` (gated). | `stakeManager.prepareClaimUnstaked` |
| `updateCommissionRate` | GATED | `staking-validator.e2e.test.ts` (skipped) | Needs a validator the test owns, which needs `stakeFor` (gated). | `stakeManager.prepareUpdateCommissionRate` |
| `updateSigner` | GATED | none | Rotates the key heimdall uses for a live validator. On the devnet's only validator that would stop checkpoints and block production, and a test-owned validator needs `stakeFor` (gated). | `stakeManager.prepareUpdateSigner` |
| `migrateDelegation` | GATED | none | Moves a delegation between two validators that both accept delegation. The devnet has one validator. | `stakeManager.prepareMigrateDelegation` |

Totals: 8 RUN, 11 GATED.

## Related checks that are not writes

- `pol.prepareApproveStakeManager` RUNS: `staking-writes.e2e.test.ts` checks that its `to` is the POL address and its `data` is byte-equal to the adapter library's own `approve` encoding (viem `encodeFunctionData`, ethers v5 and v6 `Interface.encodeFunctionData`).
- `matic.preparePermit` RUNS: it is refused with `PERMIT_NOT_SUPPORTED`, because MATIC has no EIP-2612 permit.
- `pol.preparePermit` is GATED on the devnet. It reads the EIP-712 domain from the token's ERC-5267 `eip712Domain()`. kurtosis-pos deploys POL as a generic `ERC20Permit` with `permit` and `DOMAIN_SEPARATOR` but without `eip712Domain()`, so the read reverts there. Mainnet POL implements `eip712Domain()`, and `packages/maticjs/tests/integration/staking-permit-domain.test.ts` runs `preparePermit` against it read-only on every `pnpm test`, checking the name, version, chain id and verifying contract.

## Evidence for the RUNS verdicts

Proven on 2026-11-05 against a cold-start kurtosis-pos v1.4.8 devnet (anvil L1), with the SDK's built dist. `staking-writes.e2e.test.ts` reported 15 passed and 3 skipped (the gated `preparePermit` rows). `staking-delegation.e2e.test.ts` reported 3 passed, one full cycle per adapter, in 171 s. A second run of all three staking files on the same devnet, reusing the same keys, reported 18 passed and 4 skipped in 113 s. The hashes below are from those runs. They are local devnet transactions, recorded to show each write was broadcast and confirmed. They cannot be looked up anywhere else.

| Write | viem | ethers v5 | ethers v6 |
|---|---|---|---|
| approveStakeManager (POL) | `0x9e0145216aebd81f3cedf09e38225e443670ae627bbbfe23d3ff777c2ec5de23` | `0x2ba07595c104fc5bbff88496a3d14ff56122986a7d6311ebcc5c02b4928f0726` | `0x4284d798e4168976bf17e5eeb9c6dd36520c9421b50eeb3a00f4f52d9f097a73` |
| approveStakeManager (MATIC) | `0x8a4818689abede75701d2b03a8239d6f15ef82c41d855ae6544d6f6e15846526` | `0x01e0d9da2c63187dd77653c43a099da3501b519e61fc62c9bbf66d19f751d988` | `0xcc30f9623bf0c0436fc4e313683fa14e41c8da3a2ffdb695e166a664036d80ba` |
| approveMaxForStakeManager | `0x90865740a9967630cecc809955b291d40de3ef542db4e8104673e580fc0d50d4` | `0x58903331d9b763f836edc6a861f29ee0b3e8678cb16c6da7bb1370370be561ad` | `0x0fb9cb81eda0bac232dd1d1db876575eaf606ba6581c3e0350a951e455e9f3af` |
| delegate | `0xe34ca6614ced502e8e99d02ffe2db886f88f748e2ed6a64f2bec4a50ce7a06f1` | `0x504ad4a05fead39b753e4c859c5ae329c82521ee05eeb11fecc25becd2fed4f5` | `0x28d6adf163249d86bd033699123c0c1e625de71ba3defcfca4f03348594ace94` |
| withdrawRewards | `0x1232326912c0fabebe9fa324c67597299d607953d9b762e3fcfab73b1fe664e5` | `0xd65793d463a17e64f4d3ca74805729975771cb4feb4ec5129e78c48f5806fff9` | `0x53c69a97975b3ad85a534000f3772dca216b90b632a9ae6430ceb5a75061786d` |
| restakeRewards | `0xc5323fabe657afdcc329f2907ec353bc12fd512877a257721e610508fc084a35` | `0xb7c531f5486b04cd76133747b79526ce3efa3f55b75173678d07e48c3bdad4dd` | `0xd97268017d3db1402f763de70a4b18394aebce9c3bfd728be84bb5ee81702b73` |
| undelegate | `0xcd11f13e9615c3def82927f5787e9bca7fa3338a0751f9502a382b60ed2b9417` | `0x9031f23f9e6148e9b50cd31b556abc435681f17f5e920819aa596195be04a548` | `0x46697357722e601e811f73e282769fa4adcebc27e17f364ec9c674dc26838180` |
| claimUndelegated | `0xb3085641c837587748e63f80bce3733c66e7b7aefbd6f6f50d585820c64f14ab` | `0xdf60c80c692b0dd0e66c48b5defde24c844531ccef8e889654c6c0ffd473415f` | `0xa037c6dd2818ad226a7aa091901c5c1939326d705b38aed79948fc92691afb70` |
| delegateWithPermit | `0xa3ae4d5dd1cffc10af90b37e638a825173e2c8737b9a0d14d4c27f9a343cc820` | `0xd2ba08c14c942cac59706a6c402ba9f78786b17d77d41586cfdf61b69f7232ce` | `0x4b00dbdfef5095986824ef75953663dfcf864ffdb09d8910751e67cbdcfc9e88` |

Waits observed in the first delegation run: the first rewards above `minAmount` arrived after 48 to 54 s, the next after 71 to 74 s, and an unbond became claimable 16 to 24 s after `undelegate`. Each write confirmed in about 1 s through viem (250 ms polling) and about 4 s through ethers (its default polling).

## Running the gated validator writes

They need a devnet with a second validator node behind the registered key. This tier boots a single-validator devnet and does not provide one. `E2E_VALIDATOR_WRITES` does not enable them: `staking-validator.e2e.test.ts` is skipped unconditionally until such a devnet exists.
