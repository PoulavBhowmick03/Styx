//! `erebus-vault`: one JSON request on stdin, one JSON response on stdout.

use std::io::{Read, Write};

use erebus_evm::arc_vault::service::{handle, Request};
use erebus_evm::arc_vault::{VaultCode, VaultError};
use serde_json::{json, Value};

const MAX_REQUEST_BYTES: u64 = 64 * 1024;

fn read_request() -> Result<Request, VaultError> {
    let mut input = Vec::new();
    std::io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut input)
        .map_err(|_| VaultError::new(VaultCode::InvalidRequest, "cannot read the request"))?;
    if input.len() as u64 > MAX_REQUEST_BYTES {
        return Err(VaultError::invalid("the request exceeds the size limit"));
    }
    serde_json::from_slice(&input).map_err(|_| VaultError::invalid("invalid request"))
}

async fn run() -> Result<Value, VaultError> {
    handle(read_request()?).await
}

#[tokio::main]
async fn main() {
    let (response, code) = match run().await {
        Ok(value) => (value, 0),
        Err(error) => (
            json!({"status": "error", "code": error.code.as_str(), "message": error.message}),
            1,
        ),
    };
    println!("{response}");
    if std::io::stdout().flush().is_err() {
        std::process::exit(1);
    }
    std::process::exit(code);
}
