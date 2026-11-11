package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"
	"github.com/kisshot/falky/server/internal/api"
)

var signInBodyContract = sync.OnceValue(func() routers.Router {
	document, err := api.GetSpec()
	if err != nil {
		panic(fmt.Errorf("load compiled API contract: %w", err))
	}
	document.Servers = nil
	router, err := legacy.NewRouter(document)
	if err != nil {
		panic(fmt.Errorf("route compiled API contract: %w", err))
	}
	return router
})

func validateSignInBody(request *http.Request, raw []byte) bool {
	route, _, err := signInBodyContract().FindRoute(request)
	if err != nil || route.Operation.RequestBody == nil {
		return false
	}
	media := route.Operation.RequestBody.Value.Content.Get("application/json")
	if media == nil || media.Schema == nil {
		return false
	}
	var body any
	return json.Unmarshal(raw, &body) == nil && media.Schema.Value.VisitJSON(body) == nil
}
