export enum ERROR_TYPE {
    AllowedOnRoot = "allowed_on_root",
    AllowedOnChild = "allowed_on_child",
    Unknown = "unknown",
    ProofAPINotSet = "proof_api_not_set",
    TransactionOptionNotObject = "transaction_object_not_object",
    BurnTxNotCheckPointed = "burn_tx_not_checkpointed",
    EIP1559NotSupported = "eip-1559_not_supported",
    NullSpenderAddress = "null_spender_address",
    AllowedOnNonNativeTokens = "allowed_on_non_native_token",
    AllowedOnMainnet = "allowed_on_mainnet",
    BridgeAdapterNotFound = "bridge_adapter_address_not_passed"
}
