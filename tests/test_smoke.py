async def test_health(client):
    r = await client.get("/")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["mock"] is True
    assert body["schema_version"] == 1
