import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeItemContentJson,
  decodeIterationChangesJson,
  decodeIterationsJson,
  decodePolicyChecksJson,
  decodePullRequestJson,
  decodePullRequestListJson,
  decodeThreadsJson,
} from "./azureDevOpsPullRequestJson.ts";

const REST_URL =
  "https://dev.azure.com/acme/_apis/git/repositories/6f9c9b7f-0000-0000-0000-000000000000/pullRequests/42";

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pullRequestId: 42,
    title: "Add the change requests page",
    description: "Ships the page.",
    status: "active",
    isDraft: false,
    mergeStatus: "succeeded",
    createdBy: { displayName: "Bilal Hassan", uniqueName: "bilal@acme.dev" },
    sourceRefName: "refs/heads/feat/page",
    targetRefName: "refs/heads/main",
    creationDate: "2026-07-01T00:00:00Z",
    url: REST_URL,
    repository: { name: "web", project: { name: "platform" } },
    ...overrides,
  };
}

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

const asJson = (value: unknown) => JSON.stringify(value);

const JANE_ID = "d6245f20-2af8-44f4-9451-8107cb2767db";
const BILAL_ID = "8c8c7d32-6b1b-47f4-b2e9-30b477b5ab3d";

function reviewersById() {
  const detail = expectSuccess(
    decodePullRequestJson(
      asJson(
        pullRequest({
          reviewers: [
            { id: JANE_ID, displayName: "Jane Doe", uniqueName: "jane@acme.dev", vote: 10 },
            { id: BILAL_ID, displayName: "Bilal Hassan", uniqueName: "bilal@acme.dev", vote: -10 },
          ],
        }),
      ),
    ),
  );
  if (detail === null) throw new Error("expected a pull request");
  return detail.reviewersById;
}

function voteThread(input: {
  readonly id: number;
  readonly vote: string | number | null;
  readonly voterId: string;
  readonly voterName: string;
}) {
  return {
    id: input.id,
    properties: {
      CodeReviewThreadType: { $value: "VoteUpdate" },
      ...(input.vote === null ? {} : { CodeReviewVoteResult: { $value: input.vote } }),
      CodeReviewVotedByTfId: { $value: input.voterId },
      CodeReviewVotedByDisplayName: { $value: input.voterName },
    },
    comments: [
      {
        id: 1,
        content: "Localized vote notification.",
        commentType: "system",
        author: { displayName: "Service account", uniqueName: "service@acme.dev" },
        publishedDate: `2026-07-${String(input.id).padStart(2, "0")}T00:00:00Z`,
      },
    ],
  };
}

describe("decodePullRequestListJson", () => {
  it("reads a pull request as a change request", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(
        asJson([
          pullRequest({
            labels: [{ id: "4f1c", name: "release-1.0", active: true, url: null }],
            reviewers: [{ uniqueName: "jane@acme.dev", vote: 10 }],
          }),
        ]),
      ),
    );

    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({
      number: 42,
      title: "Add the change requests page",
      author: { login: "bilal@acme.dev", name: "Bilal Hassan" },
      headBranch: "feat/page",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      labels: [{ name: "release-1.0" }],
      reviewDecision: "approved",
      reviewRequestLogins: [],
    });
  });

  it("assembles a browser url when Azure reports no web link", () => {
    const batch = expectSuccess(decodePullRequestListJson(asJson([pullRequest()])));

    expect(batch.items[0]?.url).toBe("https://dev.azure.com/acme/platform/_git/web/pullrequest/42");
  });

  it.each([
    ["completed", "merged"],
    ["something new", "open"],
  ])("reads the %s status as %s", (status, expected) => {
    const batch = expectSuccess(decodePullRequestListJson(asJson([pullRequest({ status })])));

    expect(batch.items[0]?.state).toBe(expected);
  });

  it.each([
    ["succeeded", "mergeable"],
    ["conflicts", "conflicting"],
    ["queued", "unknown"],
  ])("reads the %s merge status as %s", (mergeStatus, expected) => {
    const batch = expectSuccess(decodePullRequestListJson(asJson([pullRequest({ mergeStatus })])));

    expect(batch.items[0]?.mergeability).toBe(expected);
  });

  it("stands the closing time in for a last-touched time Azure does not keep", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(
        asJson([pullRequest({ status: "completed", closedDate: "2026-07-05T00:00:00Z" })]),
      ),
    );

    expect(batch.items[0]).toMatchObject({
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-05T00:00:00Z",
    });
  });

  it("skips a malformed row but still counts it, so paging does not stop early", () => {
    const batch = expectSuccess(
      decodePullRequestListJson(asJson([{ pullRequestId: "nope" }, pullRequest()])),
    );

    expect(batch.items).toHaveLength(1);
    expect(batch.rawCount).toBe(2);
    expect(batch.rawIndexes).toEqual([1]);
  });
});

describe("decodePullRequestJson", () => {
  it("keeps the strategy stored with auto-complete", () => {
    const armed = expectSuccess(
      decodePullRequestJson(
        asJson(
          pullRequest({
            autoCompleteSetBy: { displayName: "Bilal Hassan" },
            completionOptions: { mergeStrategy: "squash" },
          }),
        ),
      ),
    );

    expect(armed).toMatchObject({ autoMergeEnabled: true, autoMergeMethod: "squash" });

    const unspecified = expectSuccess(
      decodePullRequestJson(
        asJson(
          pullRequest({
            autoCompleteSetBy: { displayName: "Bilal Hassan" },
            completionOptions: { squashMerge: false },
          }),
        ),
      ),
    );
    expect(unspecified?.autoMergeEnabled).toBe(true);
    expect(unspecified?.autoMergeMethod).toBeUndefined();
  });

  it("works out where the repository lives from what Azure returned", () => {
    const detail = expectSuccess(decodePullRequestJson(asJson(pullRequest())));

    expect(detail?.location).toEqual({ project: "platform", repository: "web" });
  });

  it("reports no repository location when Azure said too little to name one", () => {
    const detail = expectSuccess(
      decodePullRequestJson(
        asJson(
          pullRequest({
            url: null,
            repository: null,
            _links: {
              web: { href: "https://dev.azure.com/acme/platform/_git/web/pullrequest/42" },
            },
          }),
        ),
      ),
    );

    expect(detail?.location).toBeNull();
  });

  it("returns nothing when Azure gave no way to place the pull request at all", () => {
    const detail = expectSuccess(
      decodePullRequestJson(asJson(pullRequest({ url: null, repository: null }))),
    );

    expect(detail).toBeNull();
  });

  it.each([
    ["approved by a required reviewer", [{ vote: 10, isRequired: true }], [], "approved"],
    ["rejected", [{ vote: -10 }], [], "changes-requested"],
    ["not yet voted on", [{ vote: 0, isRequired: true }], ["me@example.com"], "review-required"],
    [
      "approved but waiting on a required group",
      [{ vote: 10 }, { uniqueName: "reviewers", vote: 0, isRequired: true }],
      ["reviewers"],
      "review-required",
    ],
    [
      "approved with suggestions, with an optional reviewer still to vote",
      [{ vote: 5 }, { uniqueName: "jane@example.com", vote: 0 }],
      ["jane@example.com"],
      "approved",
    ],
    [
      "sent back to its author despite an approval",
      [{ vote: -5 }, { uniqueName: "jane@example.com", vote: 10, isRequired: true }],
      [],
      "changes-requested",
    ],
    ["without reviewers", [], [], null],
    ["approved only by its author", [{ uniqueName: "BILAL@ACME.DEV", vote: 10 }], [], null],
    [
      "rejected only by its author",
      [{ uniqueName: "BILAL@ACME.DEV", vote: -10 }, { vote: 5 }],
      [],
      "approved",
    ],
    ["with a new positive vote", [{ vote: 20 }], ["me@example.com"], "review-required"],
    ["with a new negative vote", [{ vote: -20 }], ["me@example.com"], "review-required"],
    [
      "waiting on an unknown required vote despite an approval",
      [{ vote: 10 }, { uniqueName: "required", vote: 20, isRequired: true }],
      ["required"],
      "review-required",
    ],
    ["with an absent vote", [{}], ["me@example.com"], "review-required"],
    ["with a null vote", [{ vote: null }], ["me@example.com"], "review-required"],
  ])(
    "reads the reviewers' votes on a pull request %s",
    (_case, votes, reviewRequestLogins, reviewDecision) => {
      const detail = expectSuccess(
        decodePullRequestJson(
          asJson(
            pullRequest({
              reviewers: votes.map((vote) => ({
                displayName: "Reviewer",
                uniqueName: "me@example.com",
                ...vote,
              })),
            }),
          ),
        ),
      );
      expect(detail).toMatchObject({ reviewRequestLogins, reviewDecision });
    },
  );

  it("recognizes the author's normalized identity even when their login changed", () => {
    const detail = expectSuccess(
      decodePullRequestJson(
        asJson(
          pullRequest({
            createdBy: { id: BILAL_ID, uniqueName: "new@acme.dev" },
            reviewers: [
              { id: BILAL_ID.replaceAll("-", "").toUpperCase(), uniqueName: "old", vote: -10 },
              { id: JANE_ID, uniqueName: "jane@acme.dev", vote: 10 },
            ],
          }),
        ),
      ),
    );
    expect(detail?.reviewDecision).toBe("approved");
  });
});

describe("decodeThreadsJson", () => {
  it("takes every real comment of every thread, oldest first", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              id: 2,
              comments: [
                {
                  id: 1,
                  content: "Second remark.",
                  author: { displayName: "Julius", uniqueName: "julius@acme.dev" },
                  publishedDate: "2026-07-03T00:00:00Z",
                },
              ],
            },
            {
              id: 1,
              comments: [
                { id: 1, content: "Bilal voted", commentType: "system", publishedDate: "x" },
                {
                  id: 2,
                  content: "First remark.",
                  author: { displayName: "Bilal", uniqueName: "bilal@acme.dev" },
                  publishedDate: "2026-07-02T00:00:00Z",
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(comments.map((comment) => comment.body)).toEqual(["First remark.", "Second remark."]);
    expect(comments[0]).toMatchObject({
      kind: "issue-comment",
      author: { login: "bilal@acme.dev" },
    });
  });

  it("reads a thread pinned to a file as a review comment on the path its diff uses", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              id: 3,
              threadContext: { filePath: "/src/app.ts" },
              comments: [{ id: 1, content: "Rename this.", publishedDate: "2026-07-02T00:00:00Z" }],
            },
          ],
        }),
      ),
    );

    expect(comments[0]).toMatchObject({ kind: "review-comment", path: "src/app.ts" });
  });

  it("keeps the replies under a thread, which are as much of the conversation", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              id: 4,
              threadContext: { filePath: "/src/app.ts" },
              comments: [
                { id: 1, content: "Rename this.", publishedDate: "2026-07-02T00:00:00Z" },
                { id: 2, content: "Renamed.", publishedDate: "2026-07-02T01:00:00Z" },
                { id: 3, content: "Thanks.", publishedDate: "2026-07-02T02:00:00Z" },
              ],
            },
          ],
        }),
      ),
    );

    expect(comments.map((comment) => comment.id)).toEqual(["4:1", "4:2", "4:3"]);
  });

  it("drops deleted threads and threads with nothing to show", () => {
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              id: 1,
              isDeleted: true,
              comments: [{ id: 1, content: "gone", publishedDate: "2026-07-02T00:00:00Z" }],
            },
            { id: 2, comments: [] },
            {
              id: 3,
              comments: [{ id: 1, content: "   ", publishedDate: "2026-07-02T00:00:00Z" }],
            },
          ],
        }),
      ),
    );

    expect(comments).toEqual([]);
  });

  it.each([
    ["10", "APPROVED"],
    [5, "APPROVED"],
    ["-10", "CHANGES_REQUESTED"],
    [-5, "CHANGES_REQUESTED"],
    ["0", "DISMISSED"],
    [0, "DISMISSED"],
  ])("reads legacy vote %s as %s without using the system author", (vote, reviewState) => {
    const thread = voteThread({
      id: 2,
      vote,
      voterId: JANE_ID.replaceAll("-", "").toUpperCase(),
      voterName: "Jane Doe",
    });
    const comments = expectSuccess(decodeThreadsJson(asJson({ value: [thread] }), reviewersById()));
    expect(comments).toMatchObject([
      {
        id: "2:1",
        kind: "review",
        reviewState,
        author: { login: "jane@acme.dev" },
        createdAt: "2026-07-02T00:00:00Z",
        path: null,
      },
    ]);
  });

  it("resolves the voter dictionary before legacy fields, not the initiating identity or author", () => {
    const thread = voteThread({ id: 2, vote: "10", voterId: BILAL_ID, voterName: "Bilal" });
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              ...thread,
              properties: {
                ...thread.properties,
                CodeReviewVotedByIdentity: { $value: "1" },
                CodeReviewVotedByInitiatorIdentity: { $value: "2" },
              },
              identities: {
                "1": { id: JANE_ID.replaceAll("-", "").toUpperCase(), displayName: "Old name" },
                "2": { id: BILAL_ID, uniqueName: "initiator@acme.dev" },
              },
            },
            {
              ...thread,
              id: 3,
              properties: {
                CodeReviewThreadType: { $value: "VoteUpdate" },
                CodeReviewVoteResult: { $value: "-5" },
                CodeReviewVotedByIdentity: { $value: 1 },
              },
              identities: { "1": { id: JANE_ID, uniqueName: "jane@acme.dev" } },
              comments: [{ ...thread.comments[0], author: { uniqueName: "jane@acme.dev" } }],
            },
          ],
        }),
        reviewersById(),
      ),
    );
    expect(comments.map((comment) => [comment.author?.login, comment.reviewState])).toEqual([
      ["jane@acme.dev", "APPROVED"],
      ["jane@acme.dev", "CHANGES_REQUESTED"],
    ]);
  });

  it.each(["legacy", "dictionary"] as const)(
    "keeps former voters with the same display name distinct through %s identities",
    (source) => {
      const threads = ["0f0f0f0f", "0e0e0e0e"].map((prefix, index) => {
        const id = `${prefix}-0000-0000-0000-000000000000`;
        const thread = voteThread({ id: index + 2, vote: 10, voterId: id, voterName: "Sam Lee" });
        return source === "legacy"
          ? thread
          : {
              ...thread,
              properties: {
                CodeReviewThreadType: { $value: "VoteUpdate" },
                CodeReviewVoteResult: { $value: "10" },
                CodeReviewVotedByIdentity: { $value: "1" },
              },
              identities: { "1": { id, displayName: "Sam Lee" } },
            };
      });
      const comments = expectSuccess(
        decodeThreadsJson(asJson({ value: threads }), reviewersById()),
      );
      expect(comments.map((comment) => comment.author)).toEqual([
        { login: "0f0f0f0f000000000000000000000000", name: "Sam Lee", avatarUrl: null },
        { login: "0e0e0e0e000000000000000000000000", name: "Sam Lee", avatarUrl: null },
      ]);
    },
  );

  it("keeps a dictionary voter's login after they leave the reviewer list", () => {
    const thread = voteThread({ id: 2, vote: "10", voterId: BILAL_ID, voterName: "Bilal" });
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            {
              ...thread,
              properties: {
                CodeReviewThreadType: { $value: "VoteUpdate" },
                CodeReviewVoteResult: { $value: "10" },
                CodeReviewVotedByIdentity: { $value: "1" },
              },
              identities: {
                "1": { id: JANE_ID, displayName: "Jane", uniqueName: "former@acme.dev" },
              },
            },
          ],
        }),
      ),
    );
    expect(comments[0]?.author?.login).toBe("former@acme.dev");
  });

  it("falls back to legacy identity fields when the dictionary reference is absent or unusable", () => {
    const thread = voteThread({ id: 2, vote: "10", voterId: JANE_ID, voterName: "Jane" });
    const comments = expectSuccess(
      decodeThreadsJson(
        asJson({
          value: [
            { ...thread, identities: null },
            {
              ...thread,
              id: 3,
              properties: {
                ...thread.properties,
                CodeReviewVotedByIdentity: { $value: "missing" },
              },
              identities: {},
            },
            {
              ...thread,
              id: 4,
              properties: { ...thread.properties, CodeReviewVotedByIdentity: { $value: "1" } },
              identities: { "1": {} },
            },
            {
              ...thread,
              id: 5,
              properties: {
                ...thread.properties,
                CodeReviewVotedByIdentity: { $value: "1" },
              },
              identities: { "1": null },
            },
          ],
        }),
        reviewersById(),
      ),
    );
    expect(comments.map((comment) => comment.author?.login)).toEqual([
      "jane@acme.dev",
      "jane@acme.dev",
      "jane@acme.dev",
      "jane@acme.dev",
    ]);
  });

  it("replays resets once with stable ids and leaves unrelated replies as comments", () => {
    const threads = [5, 0, 5].map((vote, index) =>
      voteThread({ id: index + 2, vote, voterId: JANE_ID, voterName: "Jane" }),
    );
    const first = threads[0];
    if (first === undefined) throw new Error("expected a vote thread");
    const payload = asJson({
      value: [
        ...threads,
        {
          ...first,
          id: 5,
          comments: [
            {
              ...first.comments[0],
              content: "Unknown voter.",
              publishedDate: "2026-07-05T00:00:00Z",
            },
            { id: 2, content: "Thanks.", publishedDate: "2026-07-06T00:00:00Z" },
          ],
          properties: {
            CodeReviewThreadType: { $value: "VoteUpdate" },
            CodeReviewVoteResult: { $value: "10" },
          },
        },
      ],
    });
    const comments = expectSuccess(decodeThreadsJson(payload, reviewersById()));
    expect(expectSuccess(decodeThreadsJson(payload, reviewersById()))).toEqual(comments);
    expect(comments.map((comment) => [comment.id, comment.reviewState])).toEqual([
      ["2:1", "APPROVED"],
      ["3:1", "DISMISSED"],
      ["4:1", "APPROVED"],
      ["5:1", "APPROVED"],
      ["5:2", null],
    ]);
    expect(comments[3]?.author).toBeNull();
    expect(comments[4]?.kind).toBe("issue-comment");
  });

  it.each([null, "", " ", "not a vote", "20", "-20"])(
    "does not infer a vote from prose when its value is %s",
    (vote) => {
      const thread = voteThread({ id: 2, vote, voterId: JANE_ID, voterName: "Jane" });
      const comments = expectSuccess(
        decodeThreadsJson(
          asJson({
            value: [
              {
                ...thread,
                comments: [
                  { ...thread.comments[0], content: "Jane approved the pull request." },
                  { id: 2, content: "Ordinary reply.", publishedDate: "2026-07-03T00:00:00Z" },
                ],
              },
            ],
          }),
          reviewersById(),
        ),
      );
      expect(comments).toMatchObject([{ id: "2:2", kind: "issue-comment", reviewState: null }]);
    },
  );
});

describe("decodeIterationsJson", () => {
  const iteration = (id: number, head: string, base: string) => ({
    id,
    sourceRefCommit: { commitId: head },
    commonRefCommit: { commitId: base },
    targetRefCommit: { commitId: base },
  });

  it("reads every push in order, oldest first", () => {
    const iterations = expectSuccess(
      decodeIterationsJson(
        asJson({ value: [iteration(2, "bbb", "base"), iteration(1, "aaa", "base")] }),
      ),
    );

    expect(iterations.map((entry) => entry.id)).toEqual([1, 2]);
    expect(iterations.at(-1)).toEqual({ id: 2, headCommit: "bbb", mergeBaseCommit: "base" });
  });

  it("skips a push Azure could not place both ends of", () => {
    const iterations = expectSuccess(
      decodeIterationsJson(
        asJson({
          value: [{ id: 1, sourceRefCommit: { commitId: "aaa" } }, iteration(2, "bbb", "base")],
        }),
      ),
    );

    expect(iterations.map((entry) => entry.id)).toEqual([2]);
  });
});

describe("decodeIterationChangesJson", () => {
  it("names each changed file without the slash Azure leads its paths with", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            { changeType: "add", item: { path: "/DEMO.md", objectId: "ec00" } },
            {
              changeType: "edit",
              item: { path: "/README.md", objectId: "8f80", originalObjectId: "0ca4" },
            },
            { changeType: "delete", item: { path: "/OLD.md", originalObjectId: "1111" } },
            // Azure names a deleted file only where it came from.
            {
              changeType: "delete",
              originalPath: "/GONE.md",
              item: { path: null, objectId: "2222", originalObjectId: "2222" },
            },
            { changeType: "delete", sourceServerItem: "/src/gone.ts", item: { objectId: null } },
            { changeType: "delete", item: { originalObjectId: "3333" } },
            { changeType: "edit", originalPath: "/LOST.md", item: { objectId: "4444" } },
          ],
        }),
      ),
    );

    expect(
      page.changes.map((change) => [
        change.path,
        change.oldPath,
        change.changeKind,
        change.objectId,
      ]),
    ).toEqual([
      ["DEMO.md", "DEMO.md", "new", "ec00"],
      ["README.md", "README.md", "change", "8f80"],
      ["OLD.md", "OLD.md", "deleted", null],
      ["GONE.md", "GONE.md", "deleted", null],
      ["src/gone.ts", "src/gone.ts", "deleted", null],
    ]);
  });

  it("keeps a space at the end of a file's name, which belongs to the name", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            { changeType: "edit", item: { path: "/docs/readme.md ", objectId: "ec00" } },
            {
              changeType: "rename",
              sourceServerItem: "/docs/old.md ",
              item: { path: "/docs/moved.md", objectId: "aaaa", originalObjectId: "aaaa" },
            },
          ],
        }),
      ),
    );

    expect(page.changes.map((change) => [change.path, change.oldPath])).toEqual([
      ["docs/readme.md ", "docs/readme.md "],
      ["docs/moved.md", "docs/old.md "],
    ]);
  });

  it("reads a rename as one file that moved, and says whether it also changed", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            {
              changeType: "rename",
              sourceServerItem: "/docs/old.md",
              item: { path: "/docs/new.md", objectId: "aaaa", originalObjectId: "aaaa" },
            },
            {
              changeType: "edit, rename",
              sourceServerItem: "/src/old.ts",
              item: { path: "/src/new.ts", objectId: "bbbb", originalObjectId: "cccc" },
            },
          ],
        }),
      ),
    );

    expect(page.changes).toEqual([
      {
        path: "docs/new.md",
        oldPath: "docs/old.md",
        changeKind: "rename-pure",
        objectId: "aaaa",
        originalObjectId: "aaaa",
      },
      {
        path: "src/new.ts",
        oldPath: "src/old.ts",
        changeKind: "rename-changed",
        objectId: "bbbb",
        originalObjectId: "cccc",
      },
    ]);
  });

  it("drops the folders Azure lists alongside the files that changed", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            { changeType: "add", item: { path: "/docs", isFolder: true, gitObjectType: "tree" } },
            { changeType: "add", item: { path: "/docs/page.md", objectId: "dddd" } },
          ],
        }),
      ),
    );

    expect(page.changes.map((change) => change.path)).toEqual(["docs/page.md"]);
  });

  it("reads where a rename came from out of either of the two places Azure names it", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          changeEntries: [
            {
              changeType: "rename",
              originalPath: "/docs/old.md",
              item: { path: "/docs/new.md", objectId: "aaaa", originalObjectId: "aaaa" },
            },
          ],
        }),
      ),
    );

    expect(page.changes.at(0)?.oldPath).toBe("docs/old.md");
  });
});

describe("decodeItemContentJson", () => {
  it("reads an empty file as empty rather than as a failure to look", () => {
    expect(expectSuccess(decodeItemContentJson(asJson({ path: "/a.md" })))).toEqual({
      contents: "",
      isBinary: false,
    });
  });
});

describe("what az devops invoke answers with", () => {
  it("reads the envelope the extension adds its own continuation token to", () => {
    expect(
      expectSuccess(decodeThreadsJson(asJson({ value: [], count: 0, continuation_token: null }))),
    ).toEqual([]);

    expect(
      expectSuccess(
        decodeIterationsJson(
          asJson({
            count: 1,
            continuation_token: null,
            value: [
              {
                id: 1,
                sourceRefCommit: { commitId: "f4031105213c68f197cd46ea303bb5e72acc889a" },
                commonRefCommit: { commitId: "acbc805382edd6c38b8d6de6ba9f9bba9da4ad35" },
              },
            ],
          }),
        ),
      ),
    ).toEqual([
      {
        id: 1,
        headCommit: "f4031105213c68f197cd46ea303bb5e72acc889a",
        mergeBaseCommit: "acbc805382edd6c38b8d6de6ba9f9bba9da4ad35",
      },
    ]);
  });

  it("keeps the files of a change that names neither their object type nor their page after it", () => {
    const page = expectSuccess(
      decodeIterationChangesJson(
        asJson({
          continuation_token: null,
          changeEntries: [
            { changeType: "add", item: { path: "/DEMO.md", objectId: "EC005DB24" } },
            { changeType: "edit", item: { path: "/README.md", objectId: "8F8047A49" } },
          ],
        }),
      ),
    );

    expect(page.nextSkip).toBeNull();
    expect(page.changes).toEqual([
      {
        path: "DEMO.md",
        oldPath: "DEMO.md",
        changeKind: "new",
        objectId: "EC005DB24",
        originalObjectId: null,
      },
      {
        path: "README.md",
        oldPath: "README.md",
        changeKind: "change",
        objectId: "8F8047A49",
        originalObjectId: null,
      },
    ]);
  });

  it("reads a text file whose content type Azure calls a stream", () => {
    expect(
      expectSuccess(
        decodeItemContentJson(
          asJson({
            path: "/README.md",
            objectId: "8f8047a49",
            gitObjectType: "blob",
            content: "# T3Demo\n",
            contentMetadata: {
              contentType: "application/octet-stream",
              encoding: 65001,
              extension: "md",
              fileName: "README.md",
            },
            continuation_token: null,
          }),
        ),
      ),
    ).toEqual({ contents: "# T3Demo\n", isBinary: false });
  });
});

describe("decodePolicyChecksJson", () => {
  const BUILD_TYPE = "0609b952-1397-4640-95ec-e00a01b2c241";
  const STATUS_TYPE = "cbdc66da-9728-4af8-aada-9a5a32e4a226";
  const CONFIGURATION_URL =
    "https://dev.azure.com/acme/6f9c9b7f-0000-0000-0000-000000000000/_apis/policy/configurations/54";

  const evaluation = (
    status: string,
    context: Record<string, unknown> | null,
    settings: Record<string, unknown> = { displayName: "PR validation" },
    configuration: Record<string, unknown> = {},
  ) => ({
    status,
    context,
    configuration: {
      url: CONFIGURATION_URL,
      isBlocking: true,
      type: { id: BUILD_TYPE, displayName: "Build" },
      settings,
      ...configuration,
    },
  });

  const decodeOne = (value: unknown, isDraft = false) =>
    expectSuccess(decodePolicyChecksJson(asJson([value]), { isDraft })).checks[0];

  it.each([
    ["approved", "success"],
    ["running", "pending"],
    ["rejected", "failure"],
    ["broken", "failure"],
    ["notApplicable", "skipped"],
    ["someNewStatus", "pending"],
  ])("reads a build evaluation %s as %s", (status, expected) => {
    expect(decodeOne(evaluation(status, { buildId: 21959 }))?.status).toBe(expected);
  });

  it("links a build to its results page, in the project the policy belongs to", () => {
    expect(decodeOne(evaluation("running", { buildId: 21959 }))).toEqual({
      name: "PR validation",
      status: "pending",
      description: null,
      url: "https://dev.azure.com/acme/6f9c9b7f-0000-0000-0000-000000000000/_build/results?buildId=21959",
      required: true,
    });
  });

  it("names a build policy without its own name after the pipeline it runs", () => {
    const check = decodeOne(evaluation("approved", { buildDefinitionName: "PR - Validation" }, {}));
    expect(check?.name).toBe("PR - Validation");
    expect(check?.url).toBeNull();
  });

  it("reads a status policy, which reports an external service's verdict", () => {
    expect(
      decodeOne(
        evaluation(
          "rejected",
          null,
          { defaultDisplayName: "SonarCloud", statusName: "gate" },
          {
            type: { id: STATUS_TYPE, displayName: "Status" },
          },
        ),
      ),
    ).toMatchObject({ name: "SonarCloud", status: "failure", url: null });
  });

  // Both arrive as `queued`; a spinner would never stop on either.
  it.each([
    {
      name: "an expired build",
      value: evaluation("queued", { buildId: 21919, isExpired: true }),
    },
    {
      name: "a build only a person can queue",
      value: evaluation("queued", null, { displayName: "Nightly", manualQueueOnly: true }),
    },
  ])("asks for action on $name", ({ value }) => {
    const check = decodeOne(value);
    expect(check?.status).toBe("action-required");
    expect(check?.description).not.toBeNull();
  });

  // A watch waits on every check that asks for action, and nobody has to queue an optional one.
  it.each([
    { name: "expired", value: evaluation("queued", { buildId: 21919, isExpired: true }) },
    {
      name: "manual-only",
      value: evaluation("queued", null, { displayName: "Nightly", manualQueueOnly: true }),
    },
  ])("skips an optional $name build that nobody queued", ({ value }) => {
    const check = decodeOne({
      ...value,
      configuration: { ...value.configuration, isBlocking: false },
    });
    expect(check?.status).toBe("skipped");
    expect(check?.description).not.toBeNull();
  });

  it("reports nothing for a build Azure holds back on a draft", () => {
    expect(decodeOne(evaluation("queued", null), true)).toBeUndefined();
    expect(decodeOne(evaluation("running", { buildId: 21960 }), true)?.status).toBe("pending");
  });

  it("keeps a build that is really waiting for an agent as running", () => {
    expect(decodeOne(evaluation("queued", { buildId: 21960, isExpired: false }))?.status).toBe(
      "pending",
    );
    expect(decodeOne(evaluation("queued", null))?.status).toBe("pending");
  });

  it.each([
    {
      name: "a review gate, which waits on people",
      configuration: { type: { id: "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd" } },
    },
    { name: "a disabled policy", configuration: { isEnabled: false } },
    { name: "a deleted policy", configuration: { isDeleted: true } },
  ])("leaves out $name but still counts the row for paging", ({ configuration }) => {
    const row = evaluation("queued", null, {}, configuration);
    expect(expectSuccess(decodePolicyChecksJson(asJson([row]), { isDraft: false }))).toEqual({
      checks: [],
      rawCount: 1,
    });
  });

  it("fails the page on a row it cannot read, which could be a required check", () => {
    const rows = asJson([evaluation("rejected", null), { status: 7 }]);
    expect(Result.isFailure(decodePolicyChecksJson(rows, { isDraft: false }))).toBe(true);
  });
});
