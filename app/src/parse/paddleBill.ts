/** PaddleOCR adapted to the bill candidate-table pipeline. */

import { paddleOcrImage, type PaddleResult } from './paddle.ts';
import { wordsToRows } from './pdfWords.ts';
import { tableFromRows } from './wordColumns.ts';
import type { CandidateTable } from './candidateTables.ts';

export interface PaddleBillResult {
  text: string;
  tables: CandidateTable[];
  warnings: string[];
}

export interface PaddleBillClient {
  read(file: Buffer): Promise<PaddleBillResult>;
}

/**
 * Keep OCR concerned only with pixels. Existing coordinate-table logic turns
 * its boxes into columns, including captions split over two visual lines.
 */
export function billResultFromPaddle(result: PaddleResult): PaddleBillResult {
  const rows = wordsToRows(result.boxes.map((box) => ({
    text: box.text,
    xMin: box.x0,
    xMax: box.x1,
    yMin: box.y0,
    yMax: box.y1,
  })));
  const table = tableFromRows(rows);

  return {
    text: result.canvas.text,
    tables: table === null ? [] : [{
      page: 1,
      method: 'paddle-ocr',
      cells: [table.header, ...table.rows],
    }],
    warnings: result.warnings,
  };
}

export function paddleBillClient(): PaddleBillClient {
  return {
    async read(file) {
      return billResultFromPaddle(paddleOcrImage(file, 'bill-image'));
    },
  };
}
