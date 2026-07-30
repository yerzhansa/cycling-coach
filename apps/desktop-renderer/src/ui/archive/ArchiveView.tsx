import { useEffect, type ReactElement } from "react";
import type { ArchiveReadingState } from "../../archive/controller.js";
import type { TranscriptTurn } from "../../chat/hydration.js";
import { useEnduragentStore } from "../../state/store.js";
import { AthleteMessage } from "../chat/AthleteMessage.js";
import { CoachMessage } from "../chat/CoachMessage.js";
import { Page } from "../shared/Page.js";
import styles from "./ArchiveView.module.css";
import {
  ARCHIVE_BACK_COPY,
  ARCHIVE_EMPTY_CONVERSATION_COPY,
  ARCHIVE_EMPTY_COPY,
  ARCHIVE_LIST_FAILURE_COPY,
  ARCHIVE_LOADING_COPY,
  ARCHIVE_LOAD_EARLIER_COPY,
  ARCHIVE_PAGE_FAILURE_COPY,
  ARCHIVE_READ_ONLY_NOTE,
  ARCHIVE_RETRY_COPY,
  ARCHIVE_TITLE,
  ARCHIVE_TRUNCATED_COPY,
  ARCHIVE_UNAVAILABLE_COPY,
  archiveReasonCopy,
  archiveTimestampCopy,
  archiveTurnCountCopy,
} from "./copy.js";

function TurnRows(props: { readonly turn: TranscriptTurn }): ReactElement {
  return (
    <>
      <article
        className={`${styles.row} ${styles.athlete} archive-message archive-message--athlete`}
        data-turn-id={props.turn.turnId}
      >
        <p className={styles.role}>You</p>
        <AthleteMessage text={props.turn.athleteText} />
      </article>
      <article
        className={`${styles.row} ${styles.coach} archive-message archive-message--coach`}
        data-turn-id={props.turn.turnId}
      >
        <p className={styles.role}>Coach</p>
        <CoachMessage text={props.turn.coachText} />
      </article>
    </>
  );
}

function ArchiveList(): ReactElement {
  const listStatus = useEnduragentStore((state) => state.archive.listStatus);
  const conversations = useEnduragentStore((state) => state.archive.conversations);
  const truncated = useEnduragentStore((state) => state.archive.truncated);
  const actions = useEnduragentStore((state) => state.archiveActions);
  const failed = listStatus === "failed";

  return (
    <>
      <p className={`${styles.note} archive-note`}>{ARCHIVE_READ_ONLY_NOTE}</p>
      <p
        className={`${styles.status} archive-status`}
        role="status"
        aria-live="polite"
        hidden={listStatus === "ready"}
      >
        {failed ? ARCHIVE_LIST_FAILURE_COPY : ARCHIVE_LOADING_COPY}
      </p>
      <button
        type="button"
        className={`${styles.pill} archive-retry`}
        hidden={!failed}
        disabled={actions === null}
        onClick={() => {
          if (!failed) return;
          actions?.retry();
        }}
      >
        {ARCHIVE_RETRY_COPY}
      </button>
      <p
        className={`${styles.status} archive-empty`}
        hidden={listStatus !== "ready" || conversations.length > 0}
      >
        {ARCHIVE_EMPTY_COPY}
      </p>
      <div className={`${styles.list} archive-list`}>
        {conversations.map((entry) => (
          <button
            key={entry.boundaryRef}
            type="button"
            className={`${styles.entry} archive-entry`}
            disabled={actions === null}
            onClick={() => {
              actions?.open(entry.boundaryRef);
            }}
          >
            <span className={styles.entryWhen}>{archiveTimestampCopy(entry.boundaryAt)}</span>
            <span className={styles.entryMeta}>
              {archiveTurnCountCopy(entry.turnCount)} · {archiveReasonCopy(entry.reason)}
            </span>
          </button>
        ))}
      </div>
      <p className={`${styles.note} archive-truncated`} hidden={!truncated}>
        {ARCHIVE_TRUNCATED_COPY}
      </p>
    </>
  );
}

function ArchiveReader(props: { readonly reading: ArchiveReadingState }): ReactElement {
  const actions = useEnduragentStore((state) => state.archiveActions);
  const reading = props.reading;
  const failed = reading.status === "failed";
  const unavailable = reading.status === "unavailable";

  return (
    <>
      <div className={styles.bar}>
        <button
          type="button"
          className={`${styles.pill} archive-back`}
          disabled={actions === null}
          onClick={() => {
            actions?.close();
          }}
        >
          {ARCHIVE_BACK_COPY}
        </button>
        <p className={`${styles.note} archive-reading-when`}>
          {reading.boundaryAt === null ? "" : archiveTimestampCopy(reading.boundaryAt)}
        </p>
      </div>
      <p className={`${styles.note} archive-note`}>{ARCHIVE_READ_ONLY_NOTE}</p>
      <p
        className={`${styles.status} archive-reading-status`}
        role="status"
        aria-live="polite"
        hidden={reading.status === "ready"}
      >
        {failed
          ? ARCHIVE_PAGE_FAILURE_COPY
          : unavailable
            ? ARCHIVE_UNAVAILABLE_COPY
            : ARCHIVE_LOADING_COPY}
      </p>
      <div className={styles.bar}>
        <button
          type="button"
          className={`${styles.pill} archive-load-earlier`}
          hidden={!reading.hasEarlier || failed}
          disabled={actions === null || reading.status === "loading"}
          onClick={() => {
            if (!reading.hasEarlier) return;
            actions?.loadEarlier();
          }}
        >
          {ARCHIVE_LOAD_EARLIER_COPY}
        </button>
        <button
          type="button"
          className={`${styles.pill} archive-retry`}
          hidden={!failed}
          disabled={actions === null}
          onClick={() => {
            if (!failed) return;
            actions?.retry();
          }}
        >
          {ARCHIVE_RETRY_COPY}
        </button>
      </div>
      <p
        className={`${styles.status} archive-empty`}
        hidden={reading.status !== "ready" || reading.turns.length > 0}
      >
        {ARCHIVE_EMPTY_CONVERSATION_COPY}
      </p>
      <section
        className={`${styles.thread} archive-thread`}
        aria-label="Past conversation"
        aria-live="off"
      >
        {reading.turns.map((turn) => (
          <TurnRows key={turn.turnId} turn={turn} />
        ))}
      </section>
    </>
  );
}

export function ArchiveView(): ReactElement {
  const listStatus = useEnduragentStore((state) => state.archive.listStatus);
  const reading = useEnduragentStore((state) => state.archive.reading);
  const actions = useEnduragentStore((state) => state.archiveActions);

  useEffect(() => {
    actions?.refresh();
  }, [actions]);

  return (
    <Page
      title={ARCHIVE_TITLE}
      busy={listStatus === "loading" || reading?.status === "loading"}
      className="archive-view"
    >
      {reading === null ? <ArchiveList /> : <ArchiveReader reading={reading} />}
    </Page>
  );
}
