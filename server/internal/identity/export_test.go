package identity

// WithSignInCodeGenerator is available only in identity's test build.
func WithSignInCodeGenerator(generate func() (string, error)) Option {
	return func(s *Service) { s.signInCode = generate }
}
