//! Record grants open only for their named recipient and issuer, and never after any change.

use styx_transport::disclosure::{DisclosureGrant, GrantError};
use styx_transport::identity::{AuthorizationIdentity, DisclosureIdentity};

fn record_grant(recipient: &DisclosureIdentity) -> DisclosureGrant {
    DisclosureGrant::seal_record(
        b"one payment record",
        [7; 16],
        &AuthorizationIdentity::from_bytes(&[1; 32]).unwrap(),
        recipient.public_key(),
        1000,
        100,
    )
    .unwrap()
}

#[test]
fn record_grants_round_trip_only_for_the_named_recipient_and_issuer() {
    let recipient = DisclosureIdentity::generate().unwrap();
    let grant = record_grant(&recipient);
    let decoded = DisclosureGrant::decode(&grant.encode().unwrap()).unwrap();
    assert_eq!(decoded.deal_id, [7; 16]);
    assert_eq!(
        decoded
            .open_record(&recipient, &decoded.issuer.clone(), 100)
            .unwrap()
            .as_slice(),
        b"one payment record"
    );
    let stranger = DisclosureIdentity::generate().unwrap();
    assert!(matches!(
        decoded.open_record(&stranger, &decoded.issuer.clone(), 100),
        Err(GrantError::WrongRecipient)
    ));
    assert!(matches!(
        decoded.open_record(&recipient, [9u8; 20], 100),
        Err(GrantError::Invalid)
    ));
    assert!(matches!(
        decoded.open_record(&recipient, &decoded.issuer.clone(), 1000),
        Err(GrantError::Expired)
    ));
}

#[test]
fn every_altered_record_grant_byte_fails_to_open() {
    let recipient = DisclosureIdentity::generate().unwrap();
    let grant = record_grant(&recipient);
    let issuer = grant.issuer.clone();
    let encoded = grant.encode().unwrap();
    for offset in 0..encoded.len() {
        let mut altered = encoded.clone();
        altered[offset] ^= 1;
        if let Ok(altered) = DisclosureGrant::decode(&altered) {
            assert!(
                altered.open_record(&recipient, &issuer, 100).is_err(),
                "byte {offset}"
            );
        }
    }
}


#[test]
fn record_grants_refuse_empty_expired_or_ownerless_input() {
    let recipient = DisclosureIdentity::generate().unwrap();
    let issuer = AuthorizationIdentity::from_bytes(&[1; 32]).unwrap();
    let key = recipient.public_key();
    assert!(DisclosureGrant::seal_record(b"", [7; 16], &issuer, key, 1000, 100).is_err());
    assert!(DisclosureGrant::seal_record(b"x", [7; 16], &issuer, key, 100, 100).is_err());
    assert!(DisclosureGrant::seal_record(b"x", [7; 16], &issuer, [0; 32], 1000, 100).is_err());
}
