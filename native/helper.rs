// The helper uses the same connection, intent journal and secret resource as Maka Settings.
use maka_app_client::{Client, Journal};
use maka_capabilities::call::{Attachments, ReadResource, ResourceEncoding};
use maka_host_runtime::application::host::{Client as Host, discovery};
use maka_plugin_core::contract::{ResourceType, text_resource_type};
use maka_plugin_core::operation::{OperationOutcome, OperationResult, Receipt};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    ops::Range,
    path::Path,
    sync::Arc,
};
use uuid::Uuid;

struct Secret(String);
impl ReadResource for Secret {
    fn encoding(&self) -> ResourceEncoding {
        ResourceEncoding::Utf8
    }
    fn resource_type(&self) -> ResourceType {
        text_resource_type()
    }
    fn bytes(&self) -> usize {
        self.0.len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
        self.0
            .as_bytes()
            .get(range)
            .map(Vec::from)
            .ok_or("invalid range".into())
    }
}

async fn request(client: &Client, req: Value) -> Result<Value, String> {
    let method = req["method"].as_str().ok_or("missing method")?;
    let input = req["input"].clone();
    match method {
        "connections" | "connection" | "credentialStatus" | "providers" => {
            client.query("settings", method, input).await
        }
        "create" | "update" | "setDefault" | "remove" | "saveCredential" => {
            let mut resources = Attachments::new();
            if method == "saveCredential" {
                let secret = req["secret"].as_str().ok_or("missing key")?;
                resources.insert("secret".into(), Arc::new(Secret(secret.into())));
            }
            let op = client
                .settings_mutation(Uuid::new_v4(), "settings", method, input, resources)
                .await?;
            op.prepare().await?;
            let reply = op.confirm().await?;
            if let Receipt::Recorded {
                outcome:
                    OperationOutcome::Returned {
                        result: OperationResult::Success { value },
                    },
                ..
            } = reply.receipt
            {
                Ok(value)
            } else {
                Err("mutation did not return success".into())
            }
        }
        _ => Err("unsupported method".into()),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("expected Maka root and client journal paths".into());
    }
    let record = discovery::read(Path::new(&args[1]))?;
    let status = Host::status(&record.endpoint, Some(record.host_epoch)).await?;
    record.verify(&status)?;
    let host = Host::connect(&record.endpoint, Some(record.host_epoch)).await?;
    let client = Client::new(
        host,
        Journal::open(Path::new(&args[2])).await?,
        "receipts".into(),
    )?;
    println!("{}", json!({"rootId":record.root_id}));
    for line in io::stdin().lock().lines() {
        let result = request(&client, serde_json::from_str(&line?)?).await;
        println!(
            "{}",
            match result {
                Ok(value) => json!({"ok":value}),
                Err(_) => json!({"error":"Settings request failed"}),
            }
        );
        io::stdout().flush()?;
    }
    client.close().await?;
    Ok(())
}
