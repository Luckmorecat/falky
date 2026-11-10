package admin

import (
	"context"
	"errors"
	"net/http"
	"net/url"

	"github.com/kisshot/falky/server/internal/identity"
)

// Lifecycle is shared with public lifecycle mutations and live/voice admission.
type Lifecycle interface {
	Lock()
	Unlock()
	Apply(context.Context, identity.Effects) error
}

type passwordBody struct {
	Password string `json:"password"`
}

func accountRoutes(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc("PUT /access/password", func(w http.ResponseWriter, r *http.Request) {
		var body passwordBody
		if !decode(w, r, &body) {
			return
		}
		err := deps.Identity.SetAccessPassword(r.Context(), body.Password)
		if errors.Is(err, identity.ErrInvalidPassword) {
			writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
			return
		}
		if adminAccountError(w, err) {
			return
		}
		deps.Logger.Info("access password set")
		writeJSON(w, 200, struct{}{})
	})
	mux.HandleFunc("GET /accounts", func(w http.ResponseWriter, r *http.Request) {
		accounts, err := deps.Identity.Accounts(r.Context())
		if adminAccountError(w, err) {
			return
		}
		writeJSON(w, 200, accounts)
	})
	mux.HandleFunc("POST /accounts/{ref}/recovery", func(w http.ResponseWriter, r *http.Request) {
		grant, err := deps.Identity.IssueRecovery(r.Context(), r.PathValue("ref"))
		if adminAccountError(w, err) {
			return
		}
		writeJSON(w, 200, grant)
	})
	mux.HandleFunc("POST /accounts/{ref}/enable", func(w http.ResponseWriter, r *http.Request) {
		if adminAccountError(w, deps.Identity.EnableAccount(r.Context(), r.PathValue("ref"))) {
			return
		}
		writeJSON(w, 200, struct{}{})
	})
	mux.HandleFunc("POST /accounts/{ref}/disable", func(w http.ResponseWriter, r *http.Request) {
		if deps.Lifecycle == nil {
			writeJSON(w, http.StatusServiceUnavailable, errorBody{Error: "lifecycle enforcement unavailable"})
			return
		}
		deps.Lifecycle.Lock()
		defer deps.Lifecycle.Unlock()
		effects, err := deps.Identity.DisableAccount(r.Context(), r.PathValue("ref"))
		if adminAccountError(w, err) {
			return
		}
		if adminAccountError(w, deps.Lifecycle.Apply(r.Context(), effects)) {
			return
		}
		writeJSON(w, 200, struct{}{})
	})
}

func adminAccountError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	status := 500
	message := "account operation failed"
	if errors.Is(err, identity.ErrNoVisitor) || errors.Is(err, identity.ErrInvalidProof) || errors.Is(err, identity.ErrDisabled) {
		status = 400
		message = "no such enabled account"
	}
	writeJSON(w, status, errorBody{Error: message})
	return true
}

// SetAccessPassword makes password the access password of the running server.
func (c *Client) SetAccessPassword(ctx context.Context, password string) error {
	var out struct{}
	return c.do(ctx, http.MethodPut, "/access/password", passwordBody{Password: password}, &out)
}

func (c *Client) Accounts(ctx context.Context) ([]identity.AccountInfo, error) {
	var out []identity.AccountInfo
	err := c.do(ctx, http.MethodGet, "/accounts", nil, &out)
	return out, err
}

func (c *Client) DisableAccount(ctx context.Context, ref string) error {
	var out struct{}
	return c.do(ctx, http.MethodPost, "/accounts/"+url.PathEscape(ref)+"/disable", nil, &out)
}

func (c *Client) EnableAccount(ctx context.Context, ref string) error {
	var out struct{}
	return c.do(ctx, http.MethodPost, "/accounts/"+url.PathEscape(ref)+"/enable", nil, &out)
}

func (c *Client) IssueRecovery(ctx context.Context, id string) (identity.RecoveryGrant, error) {
	var out identity.RecoveryGrant
	err := c.do(ctx, http.MethodPost, "/accounts/"+url.PathEscape(id)+"/recovery", nil, &out)
	return out, err
}
