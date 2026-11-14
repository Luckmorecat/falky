package identity

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
)

const (
	qrTokenLabel     = "falky/device-approval/qr-token/v1"
	deliveryKeyLabel = "falky/device-approval/delivery-key/v1"
)

func approvalKey(browser, requestID, label string) ([]byte, error) {
	return hkdf.Key(sha256.New, []byte(browser), []byte(requestID), label, 32)
}

func qrToken(browser, requestID string) (string, error) {
	key, err := approvalKey(browser, requestID, qrTokenLabel)
	return base64.RawURLEncoding.EncodeToString(key), err
}

func deliveryAAD(requestID, flow, sessionID string, expires int64) []byte {
	aad := []byte(deliveryKeyLabel)
	aad = append(aad, 1)
	for _, value := range []string{requestID, flow, sessionID} {
		aad = binary.BigEndian.AppendUint32(aad, uint32(len(value)))
		aad = append(aad, value...)
	}
	return binary.BigEndian.AppendUint64(aad, uint64(expires))
}

func deliveryAEAD(browser, requestID string) (cipher.AEAD, error) {
	key, err := approvalKey(browser, requestID, deliveryKeyLabel)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func sealDelivery(browser string, r signInRequest, sessionID, token string) ([]byte, error) {
	aead, err := deliveryAEAD(browser, r.ID)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	result := append([]byte{1}, nonce...)
	return aead.Seal(result, nonce, []byte(token), deliveryAAD(r.ID, r.Type, sessionID, r.ExpiresAt.Unix())), nil
}

func openDelivery(browser string, r signInRequest) (string, error) {
	aead, err := deliveryAEAD(browser, r.ID)
	if err != nil {
		return "", err
	}
	if len(r.ciphertext) < 1+aead.NonceSize()+aead.Overhead() || r.ciphertext[0] != 1 {
		return "", ErrInvalidProof
	}
	raw, err := aead.Open(nil, r.ciphertext[1:1+aead.NonceSize()], r.ciphertext[1+aead.NonceSize():], deliveryAAD(r.ID, r.Type, r.resultID, r.ExpiresAt.Unix()))
	if err != nil {
		return "", ErrInvalidProof
	}
	return string(raw), nil
}
