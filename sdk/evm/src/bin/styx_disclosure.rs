//! Seals vault payment records to a reviewer, and verifies them against the chain.

#[tokio::main]
async fn main() {
    styx_evm::disclosure::cli::run().await;
}
