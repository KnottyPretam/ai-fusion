"""Turn export endpoint (owner: export-backend).

    GET /api/conversations/{conv_id}/export/{turn_id}?format=md|html
        -> 200 text/markdown | text/html, one self-contained document for that ONE turn
           (Send, solo Continue, Analyze or Fusion), plus a Content-Disposition filename
           suggestion for the save dialog
        -> 404 {"detail":{"error":"not_found","what":"conversation"|"turn"}}
        -> 422 {"detail":{"error":"unknown_format","format":...,"supported":["md","html"]}}

`format` is canonically `md` or `html` (`markdown` / `htm` are accepted aliases). There is no
`pdf` format: the PDF is rendered from the HTML document by the shell that owns a printer (the
desktop shell's save dialog), which is why the HTML carries its own CSS, `@page` margins and the
`triplex-export-*` markers in its `<head>`. "All three" is three requests for the same turn -- two
here plus the shell's own PDF render -- never three different documents.

The whole document is built by `backend/export.py` (pure, no I/O); this module only loads the
conversation and sets the headers. `Conversation.anon_map` is never read, and an Analyze or Fusion
document is R-labels only (see the export module docstring, "ANONYMITY").
"""

from __future__ import annotations

from fastapi import APIRouter, Response

from .. import export
from ..store import conversations as store

router = APIRouter(prefix="/api/conversations", tags=["export"])

#: Non-simple response headers the browser may read (the dev server proxies /api, so this only
#: matters for a direct cross-origin fetch; `main.py` owns the CORS middleware and is frozen).
_EXPOSE = (
    "Content-Disposition, X-Triplex-Export-Filename, X-Triplex-Export-Type, X-Triplex-Export-Turn"
)


@router.get("/{conv_id}/export/{turn_id}")
async def export_turn(conv_id: str, turn_id: str, format: str = "md") -> Response:
    fmt = export.normalise_format(format)  # 422 before any disk read
    conv = await store.load(conv_id)
    doc = export.build_document(conv, turn_id)  # 404 conversation / turn
    filename = export.filename_for(doc, fmt)
    return Response(
        content=export.render_doc(doc, fmt),
        media_type=export.MEDIA_TYPES[fmt],
        headers={
            "content-disposition": f'attachment; filename="{filename}"',
            "x-triplex-export-filename": filename,
            "x-triplex-export-type": doc.kind,
            "x-triplex-export-turn": doc.turn_id,
            "access-control-expose-headers": _EXPOSE,
        },
    )
