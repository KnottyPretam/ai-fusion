import httpx


async def test_health(client):
    r = await client.get("/")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["mock"] is True
    assert body["schema_version"] == 1


async def test_sse_response_precheck_becomes_json_error_and_stream_works():
    """Pre-first-yield HTTPExceptions are plain JSON errors; a normal generator streams frames."""
    from fastapi import FastAPI

    from backend.api_errors import conflict
    from backend.sse import sse_response
    from tests.helpers import parse_sse_text

    app = FastAPI()

    async def failing():
        raise conflict("busy")
        yield  # pragma: no cover

    async def fine():
        yield {"type": "a"}
        yield {"type": "b", "n": 1}

    @app.post("/fail")
    async def fail():
        return await sse_response(failing())

    @app.post("/ok")
    async def ok():
        return await sse_response(fine())

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/fail")
        assert r.status_code == 409
        assert r.json() == {"detail": {"error": "busy"}}
        r = await c.post("/ok")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        assert r.headers["x-accel-buffering"] == "no"
        assert parse_sse_text(r.text) == [{"type": "a"}, {"type": "b", "n": 1}]
