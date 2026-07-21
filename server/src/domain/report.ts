/** A viewer-filed problem report against a shared document. */
export interface Report {
  readonly id: number;
  readonly shareId: string;
  readonly note: string;
  readonly createdAt: Date;
}
