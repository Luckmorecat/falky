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

func accountRoutes(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc("POST /invitations", func(w http.ResponseWriter, r *http.Request) {
		invite, err := deps.Identity.CreateInvitation(r.Context())
		if adminAccountError(w, err) {
			return
		}
		writeJSON(w, 200, invite)
	})
	mux.HandleFunc("GET /invitations", func(w http.ResponseWriter, r *http.Request) {
		invites, err := deps.Identity.Invitations(r.Context())
		if adminAccountError(w, err) {
			return
		}
		writeJSON(w, 200, invites)
	})
	mux.HandleFunc("DELETE /invitations/{id}", func(w http.ResponseWriter, r *http.Request) {
		if adminAccountError(w, deps.Identity.RevokeInvitation(r.Context(), r.PathValue("id"))) {
			return
		}
		writeJSON(w, 200, struct{}{})
	})
	mux.HandleFunc("GET /accounts", func(w http.ResponseWriter, r *http.Request) {
		accounts, err := deps.Identity.Accounts(r.Context())
		if adminAccountError(w, err) {
			return
		}
		writeJSON(w, 200, accounts)
	})
	mux.HandleFunc("POST /accounts/{id}/recovery", func(w http.ResponseWriter, r *http.Request) {
		grant, err := deps.Identity.IssueRecovery(r.Context(), r.PathValue("id"))
		if adminAccountError(w, err) {
			return
		}
		writeJSON(w, 200, grant)
	})
	mux.HandleFunc("POST /accounts/{id}/disable", func(w http.ResponseWriter, r *http.Request) {
		if deps.Lifecycle == nil {
			writeJSON(w, http.StatusServiceUnavailable, errorBody{Error: "lifecycle enforcement unavailable"})
			return
		}
		deps.Lifecycle.Lock()
		defer deps.Lifecycle.Unlock()
		effects, err := deps.Identity.DisableAccount(r.Context(), r.PathValue("id"))
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
		message = "account or invitation is unavailable"
	}
	writeJSON(w, status, errorBody{Error: message})
	return true
}

func (c *Client) CreateInvitation(ctx context.Context) (identity.Invitation, error) {
	var out identity.Invitation
	err := c.do(ctx, http.MethodPost, "/invitations", nil, &out)
	return out, err
}

func (c *Client) Invitations(ctx context.Context) ([]identity.Invitation, error) {
	var out []identity.Invitation
	err := c.do(ctx, http.MethodGet, "/invitations", nil, &out)
	return out, err
}

func (c *Client) RevokeInvitation(ctx context.Context, id string) error {
	var out struct{}
	return c.do(ctx, http.MethodDelete, "/invitations/"+url.PathEscape(id), nil, &out)
}

func (c *Client) Accounts(ctx context.Context) ([]identity.AccountInfo, error) {
	var out []identity.AccountInfo
	err := c.do(ctx, http.MethodGet, "/accounts", nil, &out)
	return out, err
}

func (c *Client) DisableAccount(ctx context.Context, id string) error {
	var out struct{}
	return c.do(ctx, http.MethodPost, "/accounts/"+url.PathEscape(id)+"/disable", nil, &out)
}

func (c *Client) IssueRecovery(ctx context.Context, id string) (identity.RecoveryGrant, error) {
	var out identity.RecoveryGrant
	err := c.do(ctx, http.MethodPost, "/accounts/"+url.PathEscape(id)+"/recovery", nil, &out)
	return out, err
}
