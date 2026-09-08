async def test_session_cost_route_reports_the_process_total(client):
    r = await client.get("/api/session/cost")
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"spent_usd", "cap_usd", "remaining_usd", "exceeded", "enforced"}
    assert body["enforced"] is False  # mock mode never enforces
    assert body["cap_usd"] == 10.0
