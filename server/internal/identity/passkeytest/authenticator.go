// Package passkeytest supplies a software authenticator for tests. Responses
// carry real P-256 signatures and go through the production WebAuthn verifier.
package passkeytest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"testing"

	"github.com/fxamacker/cbor/v2"
	"github.com/go-webauthn/webauthn/protocol"
)

type Authenticator struct {
	Key              *ecdsa.PrivateKey
	ID               []byte
	UserHandle       []byte
	Counter          uint32
	UserVerified     bool
	Discoverable     bool
	CorruptSignature bool
}

func New(t testing.TB) *Authenticator {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := make([]byte, 32)
	if _, err := rand.Read(id); err != nil {
		t.Fatal(err)
	}
	return &Authenticator{Key: key, ID: id, UserVerified: true, Discoverable: true}
}

func marshal(t testing.TB, value any) []byte {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func (a *Authenticator) authData(rp string, flags byte) []byte {
	if !a.UserVerified {
		flags &^= 0x04
	}
	hash := sha256.Sum256([]byte(rp))
	data := append(hash[:], flags)
	return binary.BigEndian.AppendUint32(data, a.Counter)
}

func (a *Authenticator) sign(t testing.TB, auth, client []byte) []byte {
	t.Helper()
	clientHash := sha256.Sum256(client)
	signed := append(append([]byte{}, auth...), clientHash[:]...)
	hash := sha256.Sum256(signed)
	sig, err := ecdsa.SignASN1(rand.Reader, a.Key, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	if a.CorruptSignature {
		sig[len(sig)-1] ^= 1
	}
	return sig
}

func (a *Authenticator) Registration(t testing.TB, options *protocol.CredentialCreation, origin string) []byte {
	t.Helper()
	switch id := options.Response.User.ID.(type) {
	case protocol.URLEncodedBase64:
		a.UserHandle = append([]byte{}, id...)
	case []byte:
		a.UserHandle = append([]byte{}, id...)
	case string:
		var err error
		a.UserHandle, err = base64.RawURLEncoding.DecodeString(id)
		if err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatalf("unsupported WebAuthn user ID type %T", id)
	}
	client := marshal(t, map[string]any{"type": "webauthn.create", "challenge": options.Response.Challenge.String(), "origin": origin})
	pub, err := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: a.Key.X.FillBytes(make([]byte, 32)), -3: a.Key.Y.FillBytes(make([]byte, 32))})
	if err != nil {
		t.Fatal(err)
	}
	auth := a.authData(options.Response.RelyingParty.ID, 0x45)
	auth = append(auth, make([]byte, 16)...)
	auth = binary.BigEndian.AppendUint16(auth, uint16(len(a.ID)))
	auth = append(auth, a.ID...)
	auth = append(auth, pub...)
	object, err := cbor.Marshal(map[string]any{"fmt": "packed", "authData": auth, "attStmt": map[string]any{"alg": -7, "sig": a.sign(t, auth, client)}})
	if err != nil {
		t.Fatal(err)
	}
	return marshal(t, map[string]any{"id": base64.RawURLEncoding.EncodeToString(a.ID), "rawId": base64.RawURLEncoding.EncodeToString(a.ID), "type": "public-key", "response": map[string]any{"clientDataJSON": base64.RawURLEncoding.EncodeToString(client), "attestationObject": base64.RawURLEncoding.EncodeToString(object)}, "clientExtensionResults": map[string]any{"credProps": map[string]any{"rk": a.Discoverable}}})
}

func (a *Authenticator) Assertion(t testing.TB, options *protocol.CredentialAssertion, origin string) []byte {
	t.Helper()
	a.Counter++
	client := marshal(t, map[string]any{"type": "webauthn.get", "challenge": options.Response.Challenge.String(), "origin": origin})
	auth := a.authData(options.Response.RelyingPartyID, 0x05)
	return marshal(t, map[string]any{"id": base64.RawURLEncoding.EncodeToString(a.ID), "rawId": base64.RawURLEncoding.EncodeToString(a.ID), "type": "public-key", "response": map[string]any{"clientDataJSON": base64.RawURLEncoding.EncodeToString(client), "authenticatorData": base64.RawURLEncoding.EncodeToString(auth), "signature": base64.RawURLEncoding.EncodeToString(a.sign(t, auth, client)), "userHandle": base64.RawURLEncoding.EncodeToString(a.UserHandle)}, "clientExtensionResults": map[string]any{}})
}
