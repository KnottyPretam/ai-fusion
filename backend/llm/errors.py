"""Error codes / error types used by the LLM layer (owner: W1).

Every failure inside ``backend.llm`` surfaces as a terminal ``Delta(kind="error", code, message,
error_type)`` -- nothing raises across the ``stream_completion`` boundary. OpenRouter's own
codes/types are passed through verbatim; the constants below name the ones Triplex mints itself.
"""

from __future__ import annotations

# error_type stamped on every error Triplex mints itself (as opposed to OpenRouter's typed
# vocabulary: rate_limit_exceeded, provider_unavailable, timeout, ...).
ERROR_TYPE_TRIPLEX = "triplex"
ERROR_TYPE_MOCK_MISS = "mock_miss"

# Codes minted by the client / mock transport.
COST_CAP_EXCEEDED = "cost_cap_exceeded"
MISSING_API_KEY = "missing_api_key"
TIMEOUT = "timeout"
TRANSPORT_ERROR = "transport_error"
HTTP_ERROR = "http_error"
MOCK_MISS = "mock_miss"

# Codes minted by complete_json's lenient parse / validation step (never a transport error).
PARSE_ERROR = "parse_error"
VALIDATION_ERROR = "validation_error"


class LLMError(Exception):
    """Internal carrier for a failure that becomes an error delta at the transport boundary."""

    def __init__(
        self, code: int | str, message: str, error_type: str | None = ERROR_TYPE_TRIPLEX
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.error_type = error_type
