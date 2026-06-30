import {
  writeBatch,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type PartialWithFieldValue,
  type SetOptions,
  type WithFieldValue
} from "firebase/firestore";

type QueuedWrite =
  | {
      type: "set";
      ref: DocumentReference<DocumentData, DocumentData>;
      data: WithFieldValue<DocumentData> | PartialWithFieldValue<DocumentData>;
      options?: SetOptions;
    }
  | {
      type: "delete";
      ref: DocumentReference<DocumentData, DocumentData>;
    };

export type FirestoreBatchWriter = {
  set<AppModelType, DbModelType extends DocumentData>(
    ref: DocumentReference<AppModelType, DbModelType>,
    data: WithFieldValue<AppModelType>
  ): unknown;
  set<AppModelType, DbModelType extends DocumentData>(
    ref: DocumentReference<AppModelType, DbModelType>,
    data: PartialWithFieldValue<AppModelType>,
    options: SetOptions
  ): unknown;
  delete<AppModelType, DbModelType extends DocumentData>(
    ref: DocumentReference<AppModelType, DbModelType>
  ): unknown;
};

export class ChunkedFirestoreBatch implements FirestoreBatchWriter {
  private writes: QueuedWrite[] = [];

  constructor(
    private readonly firestore: Firestore,
    private readonly label: string,
    private readonly maxWritesPerCommit = 425
  ) {}

  get size() {
    return this.writes.length;
  }

  set<AppModelType, DbModelType extends DocumentData>(
    ref: DocumentReference<AppModelType, DbModelType>,
    data: WithFieldValue<AppModelType>
  ): this;
  set<AppModelType, DbModelType extends DocumentData>(
    ref: DocumentReference<AppModelType, DbModelType>,
    data: PartialWithFieldValue<AppModelType>,
    options: SetOptions
  ): this;
  set<AppModelType, DbModelType extends DocumentData>(
    ref: DocumentReference<AppModelType, DbModelType>,
    data: WithFieldValue<AppModelType> | PartialWithFieldValue<AppModelType>,
    options?: SetOptions
  ) {
    this.writes.push({
      type: "set",
      ref: ref as unknown as DocumentReference<DocumentData, DocumentData>,
      data: data as WithFieldValue<DocumentData> | PartialWithFieldValue<DocumentData>,
      options
    });
    return this;
  }

  delete<AppModelType, DbModelType extends DocumentData>(
    ref: DocumentReference<AppModelType, DbModelType>
  ) {
    this.writes.push({
      type: "delete",
      ref: ref as unknown as DocumentReference<DocumentData, DocumentData>
    });
    return this;
  }

  async commit() {
    if (this.writes.length === 0) {
      console.info("[chunked-firestore-batch]", {
        label: this.label,
        totalWrites: 0,
        commitCount: 0
      });
      return;
    }

    const commitCount = Math.ceil(this.writes.length / this.maxWritesPerCommit);
    console.info("[chunked-firestore-batch]", {
      label: this.label,
      totalWrites: this.writes.length,
      maxWritesPerCommit: this.maxWritesPerCommit,
      commitCount
    });

    for (let index = 0; index < this.writes.length; index += this.maxWritesPerCommit) {
      const chunk = this.writes.slice(index, index + this.maxWritesPerCommit);
      const commitNumber = Math.floor(index / this.maxWritesPerCommit) + 1;
      console.info("[chunked-firestore-batch:commit]", {
        label: this.label,
        commitNumber,
        commitCount,
        batchSize: chunk.length
      });
      const batch = writeBatch(this.firestore);
      for (const write of chunk) {
        if (write.type === "delete") {
          batch.delete(write.ref);
          continue;
        }
        if (write.options) {
          batch.set(write.ref, write.data, write.options);
        } else {
          batch.set(write.ref, write.data);
        }
      }
      await batch.commit();
    }
  }
}
