/* =============================================
   reports.js — Excel & PDF Generator
   AKTA IAT | Returns Buffers
   ============================================= */
'use strict';

const ExcelJS     = require('exceljs');
const PDFDocument = require('pdfkit');

/**
 * Generate styled Excel workbook buffer.
 * @param {object[]} data
 * @param {{key:string, header:string, width?:number, numFmt?:string}[]} columns
 * @param {string} sheetName
 * @param {string} title
 * @param {string} generatedBy
 * @returns {Promise<Buffer>}
 */
async function generateExcel(data, columns, sheetName, title, generatedBy) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AKTA IAT';
  wb.created = new Date();

  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = columns.map(c => ({
    header: c.header,
    key:    c.key,
    width:  Math.max(Math.min(c.width || Math.max(String(c.header).length + 4, 10), 50), 10),
  }));

  // Header row styling
  const hRow = ws.getRow(1);
  hRow.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  hRow.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  hRow.height    = 22;
  hRow.alignment = { vertical: 'middle' };

  // Auto-filter on header row
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: columns.length },
  };

  // Data rows with alternating color
  data.forEach((row, ri) => {
    const r = ws.addRow(columns.map(c => row[c.key] ?? ''));
    r.height = 15;
    if (ri % 2 === 1) {
      r.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      });
    }
    if (ri % 2 === 0) {
      r.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
      });
    }
  });

  // Auto-width min 10 max 50
  ws.columns.forEach((col, ci) => {
    const headerLen = String(columns[ci]?.header || '').length;
    let max = Math.max(headerLen + 2, 10);
    col.eachCell({ includeEmpty: false }, cell => {
      const len = String(cell.value ?? '').length;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 50);
  });

  // Footer row
  ws.addRow([]);
  const footerRow = ws.addRow([]);
  ws.mergeCells(footerRow.number, 1, footerRow.number, columns.length);
  const fc = footerRow.getCell(1);
  fc.value     = `Digenerate oleh: ${generatedBy}   |   Tanggal: ${new Date().toLocaleString('id-ID')}   |   ${title}   |   AKTA IAT — Confidential`;
  fc.font      = { italic: true, size: 7.5, color: { argb: 'FF6B7280' } };
  fc.alignment = { horizontal: 'center' };
  footerRow.height = 13;

  return wb.xlsx.writeBuffer();
}

/**
 * Generate PDF document buffer.
 * @param {string} title
 * @param {string} subtitle
 * @param {{key:string, header:string, width?:number}[]} columns  width = relative unit
 * @param {object[]} rows
 * @param {string} generatedBy
 * @returns {Promise<Buffer>}
 */
function generatePDF(title, subtitle, columns, rows, generatedBy) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      margin:       40,
      size:         'A4',
      bufferPages:  true,
      autoFirstPage: true,
    });

    doc.on('data',  c  => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Cover / Header ──────────────────────────
    doc.fontSize(15).font('Helvetica-Bold').fillColor('#1E3A5F')
       .text('AKTA IAT', { align: 'center' });
    doc.fontSize(8.5).font('Helvetica').fillColor('#6B7280')
       .text('Honda Dealer Audit System', { align: 'center' });
    doc.moveDown(0.25);
    doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y)
       .strokeColor('#1E3A5F').lineWidth(1.5).stroke();
    doc.moveDown(0.4);

    doc.fontSize(13).font('Helvetica-Bold').fillColor('#111827')
       .text(title, { align: 'center' });
    if (subtitle) {
      doc.fontSize(8.5).font('Helvetica').fillColor('#6B7280')
         .text(subtitle, { align: 'center' });
    }
    doc.moveDown(0.25);
    doc.fontSize(7.5).font('Helvetica').fillColor('#9CA3AF')
       .text(`Digenerate oleh: ${generatedBy}   |   ${new Date().toLocaleString('id-ID')}`, { align: 'center' });
    doc.moveDown(0.6);

    // ── Table ────────────────────────────────────
    const pageW      = doc.page.width - 80;
    const pageBottom = doc.page.height - 56;
    const totalParts = columns.reduce((s, c) => s + (c.width || 1), 0);
    const colW       = columns.map(c => Math.floor(pageW * (c.width || 1) / totalParts));

    let y = doc.y;

    const drawHeaderRow = () => {
      let x = 40;
      columns.forEach((col, ci) => {
        const w = colW[ci] || 40;
        doc.rect(x, y, w, 18).fillAndStroke('#1E3A5F', '#1E3A5F');
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7.5)
           .text(String(col.header), x + 3, y + 5, { width: w - 6, lineBreak: false, ellipsis: true });
        x += w;
      });
      y += 18;
    };

    const drawDataRow = (rowObj, ri) => {
      const rowH  = 14;
      if (y + rowH > pageBottom) {
        doc.addPage();
        y = 44;
        drawHeaderRow();
      }
      const bg = ri % 2 === 0 ? '#FFFFFF' : '#F1F5F9';
      let x = 40;
      columns.forEach((col, ci) => {
        const w = colW[ci] || 40;
        doc.rect(x, y, w, rowH).fillAndStroke(bg, '#E5E7EB');
        doc.fillColor('#111827').font('Helvetica').fontSize(7)
           .text(String(rowObj[col.key] ?? ''), x + 3, y + 4, { width: w - 6, lineBreak: false, ellipsis: true });
        x += w;
      });
      y += rowH;
    };

    drawHeaderRow();
    rows.forEach((row, ri) => drawDataRow(row, ri));

    // ── Footer on every page ─────────────────────
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.fontSize(7).fillColor('#9CA3AF')
         .text(
           `Halaman ${i + 1} dari ${range.count}   |   AKTA IAT — Confidential`,
           40, doc.page.height - 30,
           { align: 'center', width: doc.page.width - 80 }
         );
    }

    doc.end();
  });
}

module.exports = { generateExcel, generatePDF };
