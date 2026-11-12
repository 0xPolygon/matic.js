# Staking write coverage on the devnet

The SDK has 19 staking writes. This file records, for each one, whether the devnet tier runs it and, if not, why. Every write, run or not, also has its calldata pinned by unit ground truth in `packages/maticjs/tests/unit/staking-calldata-ground-truth.test.ts`. That test proves the SDK encodes the right function and arguments. Only a devnet run proves the write lands on a real StakeManager deployment.

Verdicts:

- **RUNS**: the write is broadcast and confirmed on the devnet through all three adapters (viem, ethers v5, ethers v6), and its effect is read back on chain, through the SDK, with plain viem, or both.
- **GATED**: the write is not broadcast on the devnet, for the reason given. Calldata ground truth still covers it.

Every staking write in this tier passes the devnet's L1 chain id as `chainId`. The SDK pins staking writes to the network's L1 (Ethereum or Sepolia) by default, and the devnet is neither. The one exception is the wrong-chain row in `staking-writes.e2e.test.ts`. It leaves `chainId` out on purpose and checks that the write is refused with an `UnsupportedNetworkError` (found in the `StakingWriteError` cause chain) and that the account's nonce does not move, so nothing was broadcast.

## The 19 writes

| Write | Verdict | Where | Reason when gated | Calldata ground truth |
|---|---|---|---|---|
| `approveStakeManager` | RUNS | `staking-writes.e2e.test.ts` (POL and MATIC rows, wrong-chain row); `staking-delegation.e2e.test.ts` | | `pol.prepareApproveStakeManager`, `matic.prepareApproveStakeManager` |
| `approveMaxForStakeManager` | RUNS | `staking-writes.e2e.test.ts` | | `pol.prepareApproveMaxForStakeManager`, `matic.prepareApproveMaxForStakeManager` |
| `delegate` | RUNS | `staking-delegation.e2e.test.ts` | | `validatorShare.prepareDelegate` |
| `delegateMatic` | RUNS | `staking-writes.e2e.test.ts` | | `validatorShare.prepareDelegateMatic` |
| `delegateWithPermit` | RUNS | `staking-delegation.e2e.test.ts` | The test signs exactly the typed data `pol.preparePermit` returns, whose domain the SDK reads from the token's ERC-5267 `eip712Domain()`. It first checks that domain against the token's on-chain `DOMAIN_SEPARATOR`. | `validatorShare.prepareDelegateWithPermit`, `pol.preparePermit` |
| `undelegate` | RUNS | `staking-delegation.e2e.test.ts` | | `validatorShare.prepareUndelegate` |
| `claimUndelegated` | RUNS | `staking-delegation.e2e.test.ts` | | `validatorShare.prepareClaimUndelegated` |
| `restakeRewards` | RUNS | `staking-delegation.e2e.test.ts` | | `validatorShare.prepareRestakeRewards` |
| `withdrawRewards` | RUNS | `staking-delegation.e2e.test.ts` | | `validatorShare.prepareWithdrawRewards` |
| `stakeFor` | RUNS | `staking-validator.e2e.test.ts` | Registers a node-less validator of the test's own (`stakeForPOL`); see below. | `stakeManager.prepareStakeFor` |
| `stakeForMatic` | RUNS | `staking-validator.e2e.test.ts` | Registers a node-less validator paid in legacy MATIC (`stakeFor`); see below. | `stakeManager.prepareStakeForMatic` |
| `restake` | RUNS | `staking-validator.e2e.test.ts` | Signs as validator 1's owner; see below. | `stakeManager.prepareRestake` |
| `withdrawValidatorRewards` | RUNS | `staking-validator.e2e.test.ts` | Signs as validator 1's owner; see below. | `stakeManager.prepareWithdrawValidatorRewards` |
| `topUpHeimdallFee` | RUNS | `staking-writes.e2e.test.ts` | | `stakeManager.prepareTopUpHeimdallFee` |
| `unstake` | RUNS | `staking-validator.e2e.test.ts` | Only on the test's own node-less validators, never validator 1 or 2; see below. | `stakeManager.prepareUnstake` |
| `claimUnstaked` | RUNS | `staking-validator.e2e.test.ts` | After the withdrawal delay, on the validators the test unstaked; see below. | `stakeManager.prepareClaimUnstaked` |
| `updateCommissionRate` | RUNS | `staking-validator.e2e.test.ts` | Signs as validator 1's owner; see below. | `stakeManager.prepareUpdateCommissionRate` |
| `updateSigner` | GATED | `staking-validator.e2e.test.ts` (skipped) | StakeManager allows a signer change only `signerUpdateLimit` epochs after the validator's stake or last signer change. The devnet's limit is 100 epochs, about 40 minutes at its checkpoint rate, so on a validator the test registers it reverts `Not allowed` for longer than the run. Validators 1 and 2 are older, but rotating the key a node-backed validator signs with would stop its node signing checkpoints. Measured on a two-validator kurtosis-pos v1.4.8 devnet: `updateSigner` on a validator staked at epoch 15 reverted `Not allowed` at epoch 39. | `stakeManager.prepareUpdateSigner` |
| `migrateDelegation` | RUNS | `staking-validator.e2e.test.ts` | Between two of the test's node-less validators, to one with an id above 7; see below. | `stakeManager.prepareMigrateDelegation` |

Totals: 18 RUN, 1 GATED.

## How the newer RUNS rows prove their writes

- `topUpHeimdallFee`: StakeManager's `topUpForFee(user, heimdallFee)` has no staker check (`onlyWhenUnlocked` only), so any account that approved the fee in POL can top up any user. The test signs from a `staking` key that owns no validator NFT, tops up its own address with `minHeimdallFee`, and checks with plain viem, at the receipt's block against the block before, that the key's POL fell by exactly the fee and StakeManager's `totalHeimdallFee` rose by it. The receipt carries one `TopUpFee(user, fee)` event from StakeManager's StakingInfo logger.
- `delegateMatic`: the devnet's StakeManager is migrated to POL, and legacy MATIC delegation still lands on it. `buyVoucher` takes MATIC from the key and StakeManager converts it to POL through the migration contract. The test checks that the delegator's stake rose by the amount (to within rounding) and that the receipt has exactly one MATIC `Transfer` out of the key, to StakeManager, for the amount. It does not compare the key's MATIC balance, because `buyVoucher` first pays out the key's accrued rewards in MATIC.
- `restake`, `withdrawValidatorRewards`, `updateCommissionRate` are `onlyStaker`: only the owner of the validator NFT may call them. The test signs with validator 1's owner key. That key is public devnet material: kurtosis-pos generates it into its committed prefunded-accounts list, stakes validator 1 for its address, and writes it into heimdall's `priv_validator_key.json`. `up` reads it from that file in the enclave, and the test first checks with plain viem that the key owns NFT 1 and through the SDK that `getValidatorId` returns 1. The three adapter rows share the key, so they run one after another.
  - `restake` adds 1 POL (`stakeRewards: false`). Validator 1's `amount` rises by exactly 1 POL and the owner's POL falls by exactly 1 POL between the receipt's block and the one before.
  - `withdrawValidatorRewards` waits for a checkpoint since the last withdrawal, so there is a reward to pay. The receipt has one `ClaimRewards` event for validator 1 with a positive amount, the owner's POL rises by exactly that amount, and validator 1's stored reward is reset to its 1-wei initial value.
  - `updateCommissionRate` sets 5 (viem), then 6 (ethers v5), then the original rate (ethers v6), waiting out the one-change-per-`WITHDRAWAL_DELAY`-epochs cooldown between them. Each rate reads back with plain viem and through the SDK, and validator 1 ends on its original rate.
  - None of the three changes the validator set, but each acts on a validator whose node signs checkpoints. After each write's three rows the test runs the liveness watch described below.
- `stakeFor`, `stakeForMatic`, `migrateDelegation`, `unstake` and `claimUnstaked` run on validators the test registers itself, with no node behind them. That is safe only because the devnet has two node-backed validators (`kurtosis-params.yml`). On a one-validator devnet the same registration halted block production: heimdall's producer selection failed ("no candidates found"), bor stopped about 60 s after `stakeFor` and did not recover in 6 minutes. With two validators the rotation has a second candidate, and a node-less validator with 1 POL of stake has no say in the two-thirds checkpoint majority.
  - Each adapter row derives a fresh key for the run (`maticjs-e2e:nodeless-validator:<pol|matic>:<adapter index>:<run id>`), funds it from the admin, and registers a validator whose owner and signer are that key, with `acceptDelegation: true`. `stakeFor` pays in POL (`stakeForPOL`), `stakeForMatic` in legacy MATIC (`stakeFor`), which StakeManager converts to POL. Every later write on a validator signs with that validator's own key.
  - `stakeFor` / `stakeForMatic`: the receipt has one `Staked` event naming the key as signer and a validator id above 2. `validators(id)` holds `minDeposit` as `amount`, the key as signer, status Active and a ValidatorShare contract, the SDK's `getValidatorId` returns the id, and the key's POL or MATIC fell by exactly `minDeposit` plus `minHeimdallFee`.
  - `migrateDelegation`: StakeManager moves delegations only to a validator id above 7 ("allow to move to any non-foundation node"); the source can be any validator. Each POL row delegates 1 POL to its own validator (3, 4, 5 on a fresh devnet) and migrates it to the test's last-registered validator (8). The source's `delegatedAmount` falls by exactly 1 POL and the destination's rises by it, between the receipt's block and the one before, and the SDK's `getDelegatedAmount` agrees. It runs before `unstake`, because a share contract locks when its validator unstakes.
  - `topUpHeimdallFee` also runs here, signed by each new validator's owner for its own address: one `TopUpFee` event for the owner and the fee, and `totalHeimdallFee` up by exactly the fee.
  - `unstake` (`unstakePOL`): the receipt has one `UnstakeInit` event whose deactivation epoch is the current epoch plus one, matching `validators(id)`. The last row reproduces a gas race on purpose: it prices its `unstake` in the state right after the previous row's, waits for a checkpoint to move the epoch on, then sends, and must use more gas than that estimate.
- Gas: every StakeManager and ValidatorShare write logs `{estimate, gasLimit, gasUsed, status, blockNumber, txIndex}`. `unstake` sends with the SDK's default options, whose gas limit is the estimate times 1.15 plus a fixed 250,000 headroom. The headroom covers the epoch race: `unstake` adds the stake to `validatorStateChanges[currentEpoch + 1]`, and if a checkpoint moves the epoch between estimate and inclusion it writes the next epoch's slots from zero, 195,840 more gas measured on this devnet, whose L1 runs the Amsterdam hardfork. The gate asserts every `unstake` carries that limit (within a small estimate-drift tolerance), asserts the limit the SDK would derive from a stale estimate still covers the deterministic race row's gas used, and logs `naturalRace` per write as evidence. Node-less validators earn no checkpoint rewards (heimdall reports them as non-signers), so their `unstake` and `claimUnstaked` pay out a zero reward.
  - `claimUnstaked` (`unstakeClaimPOL`): the test polls StakeManager's epoch until it reaches the deactivation epoch plus `withdrawalDelay`, failing after 5 minutes with the epoch it was waiting for. The claim's `Unstaked` event pays the stake, the owner's POL rises by exactly the stake (whichever token it was staked in), the validator's amount is 0 with status Unstaked, and the owner holds no validator NFT.
  - The test refuses, in code, any owner write on a validator id of 2 or below. Unstaking node-backed validator 2 on a two-validator devnet froze checkpoints for good: heimdall dropped it from the signing set at once, but L1 counts its stake until its exit epoch, so validator 1 alone signed less than two thirds and every checkpoint reverted `2/3+1 non-majority!`. The exit epoch is never reached, because only a checkpoint advances the epoch.
- The liveness watch, after every group of writes in `staking-validator.e2e.test.ts`: L2 must have advanced while the writes landed, must keep producing blocks for 60 s with no gap over 20 s, and heimdall's acknowledged checkpoint count must rise after the writes, within 180 s. Blocks alone are not enough: when validator 2 was unstaked, blocks kept coming while every checkpoint reverted. A stall fails the test with the stalled block or checkpoint count. The file runs last, so a halt could not fail the files before it.

## Related checks that are not writes

- `pol.prepareApproveStakeManager` RUNS: `staking-writes.e2e.test.ts` checks that its `to` is the POL address and its `data` is byte-equal to the adapter library's own `approve` encoding (viem `encodeFunctionData`, ethers v5 and v6 `Interface.encodeFunctionData`).
- `matic.preparePermit` RUNS: it is refused with a `PermitNotSupportedError` (found in the `PermitError` cause chain), because MATIC has no EIP-2612 permit.
- `pol.preparePermit` RUNS, one row per adapter in `staking-writes.e2e.test.ts`. kurtosis-pos v1.4.9 deploys the production POL token, which implements ERC-5267 `eip712Domain()`. The row checks that the domain the SDK returns matches `eip712Domain()` field by field, that it hashes to the token's `DOMAIN_SEPARATOR`, and that the message carries the StakeManager as spender and the owner's current nonce. `delegateWithPermit` then signs what it returns. Mainnet POL is also checked read-only by `packages/maticjs/tests/live/staking-permit-domain.live.test.ts` on every `pnpm test`.

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

The five writes added later, `topUpHeimdallFee`, `delegateMatic`, `restake`, `withdrawValidatorRewards` and `updateCommissionRate`, were proven on 2026-11-06 in a full run of the whole package (`pnpm run e2e -- --down`) against a cold-start kurtosis-pos v1.4.8 devnet (anvil L1). It reported 10 test files passed, 81 tests passed and 4 skipped, in 1043 s of test time. The devnet had already run those staking files once, so the run also covers a reused devnet. The hashes below are from that run.

| Write | viem | ethers v5 | ethers v6 |
|---|---|---|---|
| topUpHeimdallFee | `0x5cdea0d72c69effa2b440d723500c9f80794f2bc994e0501233e76626a3ce46c` | `0x30436b4727b8fa824754a5c105f55a4718c5cd5b12a6d1cd9c1d7dd0b1953091` | `0x34d3b9210ef6847354274142575643baf733bca7eebb4b21f381c4f9371d49bc` |
| delegateMatic | `0x176ddb6add732a07fd8e60da3aa6e33c440e1e12aa16bbbc185d2ae04cdd2f77` | `0x7457114e50a43ba57486ddd323225ce42d58679cc23f2300da063116e99e9744` | `0xeb6d5789dbfefb7d72c8d3ab71229ba81178a596f33561a7dbf5f5b681768ca7` |
| restake | `0xd5f528ebd9a05ee8391db39a0351492d554f4256af988dd20c588a01e2dda25a` | `0x99a661a1887a338cf701d72b7e1c55fd373ebfa205e8e1cb465228f9fe3809d4` | `0x24624d9e8da925b6e9fdb943fdd357aeea0eb722cc9a60be926f42fd399b707f` |
| withdrawValidatorRewards | `0xfb9aa11792d1f32b9952aeda4825f4d00376e5385bdd01812654ca8202101c46` | `0x1f5c7b030fa757a12dc7b2566638e3a8459a585d496c3c660b7ffdbe533dca06` | `0x412d010e3c656488ccf2c95b4614038b106aed75836d9d3193cfd8194d458250` |
| updateCommissionRate | `0xc4be4935a44ca931f21daa70bfabc0304c6e6116ff10cd9ed3b67bdceb6976b0` | `0xbe3b43ee8f8f9ab4751cd0b91bcc730fd462b3ff90a22af5e755b57e8d328e14` | `0xafbfb469727854e31e6f827aec1b50b712ab1e9910f7aa69b26e53b54654c12b` |

L2 liveness after the validator-owner writes, in that run: L2 went from block 1946 to 2006 in the 60 s after `restake`, from 2043 to 2103 after `withdrawValidatorRewards`, and from 2142 to 2202 after `updateCommissionRate`. An earlier run of the file alone on the same devnet showed the same, 60 blocks in each window.

Waits observed in the first delegation run: the first rewards above `minAmount` arrived after 48 to 54 s, the next after 71 to 74 s, and an unbond became claimable 16 to 24 s after `undelegate`. Each write confirmed in about 1 s through viem (250 ms polling) and about 4 s through ethers (its default polling).

## Evidence for the validator rows on the two-validator devnet

Proven on 2026-11-09 in a full run of the whole package (`pnpm run e2e`) against a cold-start kurtosis-pos v1.4.8 devnet (anvil L1, two validators, `kurtosis-params.yml` as committed). It reported 10 test files passed, 87 tests passed and 4 skipped (the three `pol.preparePermit` rows and the gated `updateSigner`), in 1625 s of test time. The hashes below are from that run. They are local devnet transactions and cannot be looked up anywhere else.

| Write | viem | ethers v5 | ethers v6 |
|---|---|---|---|
| stakeFor (validators 3, 4, 5) | `0xf7a85a179b7af56038cac34f1e2a7efcbc474390de6c2fe7395274ddc2797338` | `0xd518ae7c16c663b7e68d01e029b118184b2829139d5ac3d6bb4f7b66a5891318` | `0x8837ee3d34bd29dc3d61f0d7b6c40afba5bd6a8075b127d2715263ae47db940e` |
| stakeForMatic (validators 6, 7, 8) | `0xcb6426ec7e40ecbb3df01d61107294155b05880c2984230d59e4a5dc8a01f31c` | `0xb6f5e262dbf199ee927374083c4ddf8fdcb36f1227ced5e1edb351c6ead30cb1` | `0xe84edacd059d4898c0f61814d4be7dfa4c7ec7ffa4924291fe6ef006674eac12` |
| migrateDelegation (3, 4, 5 to 8) | `0x69be7dc7350d2f1bd5faa5a23934ca96a17566c62cc63985d29ba8fdcc49a215` | `0x2f504ee8ce1ff8b673d4315c8b3a6582894c80ff341f2f8fe5422788db0541b8` | `0xaf8d8175aa7db0cbe14a7c9c0613ecaf6239b292d7a6a385bb26e00da6db1b65` |
| topUpHeimdallFee (new owners) | `0xed3e4b405b5d09a28784e810227d1fd8b29e9a367a0a0f957c70943d56c641d5` | `0xcc7457ee1f1cb9aca4f9e2ba4b9244b3a914fa35f7d39d0c533b9096120b509a` | `0x249c32fe2d422115b6c25a22683b649abc1753d094641fcc6f9a4758037057c8` |
| unstake (POL validators) | `0x3100251f79bfd91589b44b8b735f458f996e3aebd6594165750ea11c395134ad` | `0x7dad8c2e1fcd95848bc85260b00421c265ecc660dbc32f4fc185d6afdb773810` | `0x578381e29421ba91a78fd46e432eae36c5839dc634164455add0027e52cff554` |
| unstake (MATIC validators) | `0x448d2046f462309c33809b78f829da4b9b936814c3f75f4694ac04c94210f34b` | `0x56bbc91c638dc14e71e6dde0e6745cae820d552f881328c13f392e9b897ec317` | `0xefde9d6ca3e9ed9032203d608bb126bd5579e969997220ae8442d9f6e9d9bc0f` |
| claimUnstaked (POL validators) | `0x93288d66c8c3891da9ec6874b72a14ae53294ebc7e258d49d9b0c479010acb3c` | `0x78ec03847ae2f532d23bc0ab3aac2a16cee9056917d10d3dd43c96b221ee96a7` | `0x6b936311e0cfc9acc39bddc8ca8ebc9ed771999f3f5380105253eb3dcf3def41` |
| claimUnstaked (MATIC validators) | `0x1d08265c7d98c310f8787d0a9b40b01e0947858c87339e0f525c53e815f5e843` | `0x28fde61ecee273fc1a6095c1e486a237b3846d4498f3751c51e91e656a10b899` | `0x3107ccd9a43eddd1969e8fee7df83e9efa0cdb9de6751a0e031a51a3e280799a` |

The liveness watch in that run, as L2 block and heimdall checkpoint acks before the writes, right after them, and at the end of the watch:

| Writes | Before | After the writes | End of watch |
|---|---|---|---|
| restake (validator 1) | 1243, 41 | 1261, 42 | 1321, 44 |
| withdrawValidatorRewards (validator 1) | 1321, 44 | 1364, 46 | 1424, 48 |
| updateCommissionRate (validator 1) | 1424, 48 | 1473, 50 | 1533, 52 |
| stakeFor | 1537, 52 | 1555, 53 | 1615, 55 |
| stakeForMatic | 1615, 55 | 1634, 55 | 1691, 57 |
| migrateDelegation | 1691, 57 | 1718, 57 | 1779, 59 |
| unstake | 1797, 59 | 1815, 60 | 1875, 62 |
| claimUnstaked | 1875, 62 | 1893, 62 | 1953, 64 |

Each watch lasted 60 s. The same file had passed twice before on another two-validator devnet of the same config: once whole, and once for the node-less rows alone, re-run on the same devnet with fresh keys (validators 9 to 14), which also covers a reused devnet.

## The gated write

`updateSigner` stays gated: see its row. It could run on a test-owned validator only after waiting out `signerUpdateLimit` (100 epochs, about 40 minutes), or on a devnet deployed with a lower limit.
