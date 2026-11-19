"""换行码点（CR / LF / CRLF）端到端测试。

保障：
- 服务端原样保存三种换行形式，不会在任何环节规范化或吞掉 CR；
- 码点计数、标签区间、落点高亮与下载都按原样文本定位；
- 标签可只覆盖 CRLF 的一半（单独的 CR 或 LF 码点）；
- 输入校验失败时会话与此前已确认的下载都保留；
- 前端静态资源（含编辑器脚本）可正常加载。
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        yield c


def create(client, original, revised, labels):
    r = client.post("/api/sessions", json={
        "original": original, "revised": revised, "labels": labels})
    assert r.status_code == 201, r.text
    return r.json()


class TestNewlineRoundtrip:
    def test_mixed_endings_preserved_on_create_and_get(self, client):
        s = "甲\r\n乙\n丙\r丁"
        t = "甲\r\n乙\n丙\r丁戊"
        st = create(client, s, t, [])
        assert st["original"] == s
        assert st["revised"] == t
        got = client.get(f"/api/sessions/{st['session_id']}").json()
        assert got["original"] == s
        assert got["revised"] == t

    def test_label_only_change_keeps_body_cr(self, client):
        # 只改标签、不动正文：正文里的 CR 必须原样保留
        s = "ab\r\ncd\ref"
        t = "ab\r\ncdX\ref"
        st = create(client, s, t, [{"id": "k", "start": 0, "end": 1}])
        sid = st["session_id"]
        r = client.put(f"/api/sessions/{sid}/inputs", json={
            "original": s, "revised": t,
            "labels": {"labels": [{"id": "renamed", "start": 0, "end": 1}]}})
        assert r.status_code == 200
        body = r.json()
        assert body["original"] == s
        assert body["revised"] == t
        assert body["labels"][0]["id"] == "renamed"
        assert body["revision"] == 2

    def test_partial_body_edit_keeps_rest_including_cr(self, client):
        s = "头\r\n中\r尾\n末"
        t = "头\r\n首\r尾\n末"          # 只换一个普通字，换行形式不动
        st = create(client, s, t, [])
        assert st["original"] == s
        assert st["revised"] == t

    def test_half_crlf_labels_accepted_and_auto_migrated(self, client):
        s = "ab\r\ncd"                  # 码点 0a 1b 2CR 3LF 4c 5d
        labels = {"labels": [
            {"id": "cr-half", "start": 2, "end": 3},
            {"id": "lf-half", "start": 3, "end": 4},
        ]}
        st = create(client, s, s, labels)
        infos = {l["id"]: l for l in st["analysis"]["labels"]}
        assert infos["cr-half"]["text"] == "\r"
        assert infos["lf-half"]["text"] == "\n"
        assert infos["cr-half"]["status"] == "auto"
        assert infos["cr-half"]["possible"] == [2]
        assert infos["lf-half"]["possible"] == [3]

    def test_download_uses_raw_text_and_raw_offsets(self, client):
        s = "ab\r\ncd"
        t = "ab\r\ncdX"
        st = create(client, s, t, [
            {"id": "cr-half", "start": 2, "end": 3},
            {"id": "word", "start": 4, "end": 6},
        ])
        sid, rev = st["session_id"], st["revision"]
        r = client.post(f"/api/sessions/{sid}/confirm", json={"revision": rev})
        assert r.status_code == 200, r.text
        result = r.json()["result"]
        assert result["revised"] == t                      # CRLF 原样
        by_id = {l["id"]: l for l in result["labels"]}
        assert by_id["cr-half"] == {
            "id": "cr-half", "start": 2, "end": 3, "text": "\r"}
        assert by_id["word"]["text"] == "cd"
        # 下载端点内容一致
        d = client.get(f"/api/sessions/{sid}/download")
        assert d.status_code == 200
        assert d.json()["revised"] == t
        assert d.json()["labels"][0]["text"] == "\r"

    def test_codepoint_limit_counts_cr_individually(self, client):
        # 40 组 "a\r\n" = 40×3 = 120 码点（CR、LF 各算一个），应当接受；
        # 再加一个普通字即 121，拒绝
        ok = "a\r\n" * 40
        assert len(ok) == 120
        r = client.post("/api/sessions", json={
            "original": ok, "revised": ok, "labels": []})
        assert r.status_code == 201
        too_long = ok + "x"
        r = client.post("/api/sessions", json={
            "original": too_long, "revised": ok, "labels": []})
        assert r.status_code == 400
        assert "120" in r.json()["detail"]


class TestValidationFailureKeepsState:
    def test_invalid_labels_keep_session_and_prior_download(self, client):
        s = "ab\r\ncd"
        st = create(client, s, s, [{"id": "k", "start": 0, "end": 2}])
        sid, rev = st["session_id"], st["revision"]
        r = client.post(f"/api/sessions/{sid}/confirm", json={"revision": rev})
        assert r.status_code == 200
        # 此前已确认的下载可用
        assert client.get(f"/api/sessions/{sid}/download").status_code == 200

        # 非法标签（空区间）：400，revision 不变，正文 CR 不丢，下载仍可用
        r = client.put(f"/api/sessions/{sid}/inputs", json={
            "original": s, "revised": s,
            "labels": {"labels": [{"id": "bad", "start": 1, "end": 1}]}})
        assert r.status_code == 400
        got = client.get(f"/api/sessions/{sid}").json()
        assert got["revision"] == rev
        assert got["original"] == s
        assert client.get(f"/api/sessions/{sid}/download").status_code == 200

    def test_text_too_long_keeps_prior_result(self, client):
        st = create(client, "abc", "abc", [{"id": "a", "start": 0, "end": 1}])
        sid, rev = st["session_id"], st["revision"]
        client.post(f"/api/sessions/{sid}/confirm", json={"revision": rev})
        r = client.put(f"/api/sessions/{sid}/inputs", json={
            "original": "x" * 121, "revised": "abc", "labels": []})
        assert r.status_code == 400
        assert client.get(f"/api/sessions/{sid}/download").status_code == 200
        got = client.get(f"/api/sessions/{sid}").json()
        assert got["revision"] == rev

    def test_stale_selection_still_409_after_failed_validation(self, client):
        # 校验失败不会推进 revision，旧版本号语义不变
        st = create(client, "a\r\nb", "a\r\nb", [])
        sid, rev = st["session_id"], st["revision"]
        r = client.put(f"/api/sessions/{sid}/inputs", json={
            "original": "a\r\nb", "revised": "a\r\nb",
            "labels": {"labels": [{"start": 0, "end": 0}]}})
        assert r.status_code == 400
        r = client.put(f"/api/sessions/{sid}/selections", json={
            "revision": rev + 1, "selections": {}})
        assert r.status_code == 409


class TestStaticAssets:
    def test_editor_scripts_served(self, client):
        for path in ("/", "/static/app.js", "/static/editor.js",
                     "/static/editor-core.js", "/static/preview-core.js",
                     "/static/style.css"):
            r = client.get(path)
            assert r.status_code == 200, path
        # 页面已挂载新编辑器脚本
        html = client.get("/").text
        assert "editor-core.js" in html and "editor.js" in html
        assert "preview-core.js" in html
