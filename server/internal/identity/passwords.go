package identity

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// Password length bounds, in characters. There are no composition rules.
const (
	MinPasswordLength = 8
	MaxPasswordLength = 128
)

// Login length bounds, in characters.
const (
	MinLoginLength = 3
	MaxLoginLength = 32
)

var (
	ErrInvalidPassword     = fmt.Errorf("a password must be %d to %d characters long", MinPasswordLength, MaxPasswordLength)
	ErrInvalidLogin        = fmt.Errorf("a login must be %d to %d latin letters, digits, dots, dashes or underscores, starting with a letter or digit", MinLoginLength, MaxLoginLength)
	ErrLoginTaken          = errors.New("another account has this login")
	ErrLoginRequired       = errors.New("this account has no login yet; choose one")
	ErrWrongCredentials    = errors.New("wrong login or password")
	ErrAccessRequired      = errors.New("enter the access password first")
	ErrAccessUnset         = errors.New("the operator has not set the access password")
	ErrWrongAccessPassword = errors.New("wrong access password")
)

// PasswordCost is the Argon2id work factor of new password hashes. Stored
// hashes carry their own parameters, so changing it never locks anyone out.
type PasswordCost struct {
	Time      uint32
	MemoryKiB uint32
}

// DefaultPasswordCost is OWASP's minimum Argon2id configuration.
var DefaultPasswordCost = PasswordCost{Time: 2, MemoryKiB: 19 * 1024}

// WithPasswordCost hashes new passwords at cost instead of DefaultPasswordCost.
// Tests use a low cost to stay fast.
func WithPasswordCost(cost PasswordCost) Option {
	return func(s *Service) { s.passwordCost = cost }
}

// CleanLogin returns raw trimmed and lowercased, or ErrInvalidLogin.
func CleanLogin(raw string) (string, error) {
	login := strings.ToLower(strings.TrimSpace(raw))
	if len(login) < MinLoginLength || len(login) > MaxLoginLength {
		return "", ErrInvalidLogin
	}
	for i, r := range login {
		alnum := r >= 'a' && r <= 'z' || r >= '0' && r <= '9'
		if !alnum && (i == 0 || r != '.' && r != '-' && r != '_') {
			return "", ErrInvalidLogin
		}
	}
	return login, nil
}

// checkPasswordRules fails with ErrInvalidPassword for a password that is too
// short or too long. Every character counts, spaces included.
func checkPasswordRules(password string) error {
	if !utf8.ValidString(password) {
		return ErrInvalidPassword
	}
	n := utf8.RuneCountInString(password)
	if n < MinPasswordLength || n > MaxPasswordLength {
		return ErrInvalidPassword
	}
	return nil
}

// hashPassword returns password's Argon2id hash in the PHC string format.
// Hashing takes memory, so at most a few run at once.
func (s *Service) hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	cost := s.passwordCost
	s.hashing <- struct{}{}
	key := argon2.IDKey([]byte(password), salt, cost.Time, cost.MemoryKiB, 1, 32)
	<-s.hashing
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=1$%s$%s", argon2.Version, cost.MemoryKiB, cost.Time, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// passwordMatches reports whether password hashes to encoded. An empty or
// malformed hash never matches, but still costs a hash so that its timing
// does not tell an unknown login from a wrong password.
func (s *Service) passwordMatches(encoded, password string) bool {
	var memory, time uint32
	var salt, want []byte
	ok := false
	parts := strings.Split(encoded, "$")
	if len(parts) == 6 && parts[1] == "argon2id" && parts[2] == fmt.Sprintf("v=%d", argon2.Version) {
		var threads uint8
		_, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &threads)
		b64 := base64.RawStdEncoding
		var errSalt, errKey error
		salt, errSalt = b64.DecodeString(parts[4])
		want, errKey = b64.DecodeString(parts[5])
		ok = err == nil && errSalt == nil && errKey == nil && threads == 1 && len(want) == 32 && time > 0 && memory > 0 && memory <= 256*1024
	}
	if !ok {
		memory, time, salt, want = s.passwordCost.MemoryKiB, s.passwordCost.Time, make([]byte, 16), make([]byte, 32)
	}
	s.hashing <- struct{}{}
	got := argon2.IDKey([]byte(password), salt, time, memory, 1, 32)
	<-s.hashing
	return ok && subtle.ConstantTimeCompare(got, want) == 1
}
