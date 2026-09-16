import { describe, expect, it } from 'vitest';
import { billResultFromPaddle } from '../src/parse/paddleBill.ts';
import { boxesToCanvas, type OcrBox } from '../src/parse/ocrCanvas.ts';

const box = (text: string, x0: number, y0: number): OcrBox => ({
  text, x0, x1: x0 + text.length * 7, y0, y1: y0 + 12, score: 0.99,
});

describe('PaddleOCR bill adapter', () => {
  it('turns local OCR boxes into the same candidate tables used for PDFs', () => {
    const boxes = [
      box('Qty', 20, 100), box('Taxable', 100, 100),
      box('IGST', 220, 100), box('Total', 320, 100),
      box('1', 20, 140), box('100.00', 100, 140),
      box('18.00', 220, 140), box('118.00', 320, 140),
    ];
    const result = billResultFromPaddle({
      provider: 'paddleocr', boxes, canvas: boxesToCanvas(boxes),
      meanConfidence: 0.99, elapsedMs: 10, version: 'test', warnings: [],
    });

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.method).toBe('paddle-ocr');
    expect(result.tables[0]?.cells).toEqual([
      ['Qty', 'Taxable', 'IGST', 'Total'],
      ['1', '100.00', '18.00', '118.00'],
    ]);
  });

  it('keeps the abbreviated amount heading used by grocery receipts', () => {
    const boxes = [
      box('Description', 20, 100), box('Qty', 170, 100),
      box('Rate', 250, 100), box('Amt To', 340, 100),
      box('Milk', 20, 140), box('1.00', 170, 140),
      box('30.00', 250, 140), box('30.00', 340, 140),
    ];
    const result = billResultFromPaddle({
      provider: 'paddleocr', boxes, canvas: boxesToCanvas(boxes),
      meanConfidence: 0.99, elapsedMs: 10, version: 'test', warnings: [],
    });
    expect(result.tables[0]?.cells[0]).toEqual(['Description', 'Qty', 'Rate', 'Amt To']);
  });
});
