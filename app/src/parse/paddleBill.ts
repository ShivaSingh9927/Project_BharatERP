/** PaddleOCR adapted to the bill candidate-table pipeline. */

import { paddleOcrDocument, type PaddleResult } from './paddle.ts';
import type { OcrBox } from './ocrCanvas.ts';
import { wordsToRows } from './pdfWords.ts';
import { tableFromRows } from './wordColumns.ts';
import type { CandidateTable } from './candidateTables.ts';

export interface PaddleBillResult {
  text: string;
  tables: CandidateTable[];
  warnings: string[];
}

export interface PaddleBillClient {
  read(file: Buffer, opts?: { password?: string }): Promise<PaddleBillResult>;
}

/**
 * Keep OCR concerned only with pixels. Existing coordinate-table logic turns
 * its boxes into columns, including captions split over two visual lines.
 */
export function billResultFromPaddle(
  result: PaddleResult & { pageBoxes?: OcrBox[][] },
): PaddleBillResult {
  const pages = result.pageBoxes ?? [result.boxes];
  const tables = pages.flatMap((boxes, index) => {
    const rows = wordsToRows(boxes.map((box) => ({
      text: box.text,
      xMin: box.x0,
      xMax: box.x1,
      yMin: box.y0,
      yMax: box.y1,
    })));
    const table = tableFromRows(rows);
    return table === null ? [] : [{
      page: index + 1,
      method: 'paddle-ocr' as const,
      cells: [table.header, ...table.rows],
    }];
  });

  return {
    text: result.canvas.text,
    tables,
    warnings: result.warnings,
  };
}

export function paddleBillClient(): PaddleBillClient {
  return {
    async read(file, opts) {
      return billResultFromPaddle(paddleOcrDocument(file, {
        password: opts?.password,
        fileName: 'bill-image',
      }));
    },
  };
}
