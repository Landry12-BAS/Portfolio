"""Drawing a laid-out document as a PDF with ReportLab: the clean, born-digital seed documents.

The PDF is made so that the same input gives the same bytes: ReportLab's `invariant` mode fixes the
dates and the document ID, the pages are not compressed (a smaller file is not worth a different zlib
changing the bytes), and only the standard fonts are used, which are not embedded. Whatever draws it,
the position of every run is the one the layout chose, so the manifest's boxes are exact.
"""

import io

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen.canvas import Canvas

from lb03.synthetic.layout import Page, Run

# Where the baseline sits inside a run's box, as a share of its height from the top.
BASELINE = 0.8


class PdfMeasurer:
    """Measures text with the widths of the PDF standard fonts."""

    def width(self, text: str, font: str, size: float) -> float:
        """Return the width of `text` in points."""
        return float(pdfmetrics.stringWidth(text, font, size))


def draw_runs(canvas: Canvas, page: Page) -> None:
    """Draw a page's rules, text and stamp on a canvas."""
    height = page.height
    for rule in page.rules:
        canvas.saveState()
        canvas.setLineWidth(rule.thickness)
        canvas.setStrokeGray(rule.gray)
        canvas.setFillGray(rule.gray)
        if rule.dashed:
            canvas.setDash(2, 2)
        if rule.filled:
            canvas.rect(rule.x0, height - rule.y1, rule.x1 - rule.x0, rule.y1 - rule.y0, stroke=0, fill=1)
        else:
            canvas.line(rule.x0, height - rule.y0, rule.x1, height - rule.y1)
        canvas.restoreState()
    for run in page.runs:
        draw_run(canvas, run, height)
    if page.stamp:
        canvas.saveState()
        canvas.translate(page.width / 2, height / 2)
        canvas.rotate(35)
        canvas.setFillGray(0.82)
        canvas.setFont("Helvetica-Bold", 72)
        canvas.drawCentredString(0, 0, page.stamp)
        canvas.restoreState()


def draw_run(canvas: Canvas, run: Run, page_height: float) -> None:
    """Draw one run of text, its baseline set inside its box."""
    canvas.setFont(run.font, run.size)
    canvas.setFillGray(0.05)
    canvas.drawString(run.x, page_height - (run.y + BASELINE * run.size), run.text)


def render_pdf(pages: list[Page]) -> bytes:
    """Draw the pages as one PDF and return its bytes."""
    buffer = io.BytesIO()
    first = pages[0]
    canvas = Canvas(buffer, pagesize=(first.width, first.height), invariant=1, pageCompression=0)
    canvas.setTitle("Synthetic Basalt & Bean document")
    canvas.setAuthor("Basalt & Bean Coffee Co. synthetic data")
    for page in pages:
        canvas.setPageSize((page.width, page.height))
        draw_runs(canvas, page)
        canvas.showPage()
    canvas.save()
    return buffer.getvalue()
