import assert from "node:assert/strict";
import test from "node:test";
import type { StaffStudyRepository } from "@clarity/database/study-repository";
import {
  createScopedDicomwebGateway,
  createScopedOhifProxy,
} from "../src/viewer/scoped-dicomweb.ts";

const STAFF_ID = "a495f83e-2e3f-41cd-82ec-88c5f30635d1";
const REPORT_ID = "b495f83e-2e3f-41cd-82ec-88c5f30635d1";
const STUDY_UID = "1.2.840.10008.1.2.3";
const SERIES_UID = "1.2.840.10008.1.2.3.4";
const SOP_UID = "1.2.840.10008.1.2.3.4.5";

function fixture(
  options: Readonly<{
    authorized?: boolean;
    cookieRequired?: boolean;
    upstream?: (request: Request) => Promise<Response> | Response;
    members?: readonly { seriesInstanceUid: string; sopInstanceUid: string }[];
  }> = {},
) {
  const calls: Request[] = [];
  const studies = {
    async findViewableReportByStudyUid(_staffUserId: string, uid: string) {
      if (uid !== STUDY_UID || options.authorized === false) return null;
      return {
        reportId: REPORT_ID,
        sourceId: "c495f83e-2e3f-41cd-82ec-88c5f30635d1",
        orthancStudyId: "synthetic-cloud-study",
        studyInstanceUid: STUDY_UID,
        patientName: "Synthetic Patient",
        studyDate: "20260923",
        studyDescription: "Synthetic CT",
        modalities: ["CT"],
      };
    },
    async authorizeDicomwebRequest(input: {
      seriesInstanceUid: string | null;
      sopInstanceUid: string | null;
    }) {
      const members = options.members ?? [
        { seriesInstanceUid: SERIES_UID, sopInstanceUid: SOP_UID },
      ];
      return members.some(
        (member) =>
          member.seriesInstanceUid === input.seriesInstanceUid &&
          (input.sopInstanceUid === null || member.sopInstanceUid === input.sopInstanceUid),
      );
    },
    async listViewableMembers() {
      return options.members ?? [{ seriesInstanceUid: SERIES_UID, sopInstanceUid: SOP_UID }];
    },
  } as unknown as StaffStudyRepository;
  const gateway = createScopedDicomwebGateway({
    orthancDicomwebUrl: "http://orthanc:8042/dicom-web/",
    username: "synthetic-viewer",
    password: "synthetic-only",
    staff: {
      async requireStaffRead(cookie) {
        if (options.cookieRequired && cookie !== "hanko=valid") {
          return { ok: false as const, status: 401 as const, reason: "unauthenticated" as const };
        }
        return { ok: true as const, principal: { staffUserId: STAFF_ID, role: "staff" as const } };
      },
    },
    studies,
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return options.upstream ? options.upstream(request) : Response.json([]);
    },
  });
  return { gateway, calls };
}

test("requires a current staff session and an explicit Study UID for QIDO", async () => {
  const { gateway, calls } = fixture({ cookieRequired: true });
  const denied = await gateway.handle(new Request("https://staff.example.test/dicom-web/studies"), [
    "studies",
  ]);
  assert.equal(denied.status, 401);
  const noFilter = await gateway.handle(
    new Request("https://staff.example.test/dicom-web/studies", {
      headers: { cookie: "hanko=valid" },
    }),
    ["studies"],
  );
  assert.equal(noFilter.status, 400);
  assert.equal(calls.length, 0);
});

test("scopes QIDO results to current manifest members and disables browser caches", async () => {
  const { gateway, calls } = fixture({
    upstream: () =>
      Response.json([
        {
          "0020000D": { Value: [STUDY_UID] },
          "0020000E": { Value: [SERIES_UID] },
          "00080018": { Value: [SOP_UID] },
        },
        {
          "0020000D": { Value: [STUDY_UID] },
          "0020000E": { Value: [SERIES_UID] },
          "00080018": { Value: ["1.2.840.10008.1.2.3.4.6"] },
        },
        {
          "0020000D": { Value: ["1.2.840.999"] },
          "0020000E": { Value: [SERIES_UID] },
          "00080018": { Value: [SOP_UID] },
        },
      ]),
  });
  const result = await gateway.handle(
    new Request(
      `https://staff.example.test/dicom-web/studies/${STUDY_UID}/series/${SERIES_UID}/instances`,
    ),
    ["studies", STUDY_UID, "series", SERIES_UID, "instances"],
  );
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    `http://orthanc:8042/dicom-web/studies/${STUDY_UID}/series/${SERIES_UID}/instances`,
  );
  assert.match(calls[0]?.headers.get("authorization") ?? "", /^Basic /);
  const body = (await result.json()) as unknown[];
  assert.equal(body.length, 1);
  assert.equal((body[0] as Record<string, unknown>)["00080018"] !== undefined, true);
});

test("denies a nonmember SOP before contacting Orthanc", async () => {
  const { gateway, calls } = fixture();
  const result = await gateway.handle(
    new Request(
      "https://staff.example.test/dicom-web/studies/1.2.840.10008.1.2.3/series/1.2.840.10008.1.2.3.4/instances/1.2.840.10008.1.2.3.4.99",
    ),
    ["studies", STUDY_UID, "series", SERIES_UID, "instances", "1.2.840.10008.1.2.3.4.99"],
  );
  assert.equal(result.status, 404);
  assert.equal(calls.length, 0);
});

test("streams binary WADO bodies and preserves source-offline cloud access", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { gateway, calls } = fixture({
    upstream: (request) => {
      assert.equal(request.headers.get("accept"), 'multipart/related; type="application/dicom"');
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { headers: { "content-type": 'multipart/related; type="application/dicom"' } },
      );
    },
  });
  const result = await gateway.handle(
    new Request(
      "https://staff.example.test/dicom-web/studies/1.2.840.10008.1.2.3/series/1.2.840.10008.1.2.3.4/instances/1.2.840.10008.1.2.3.4.5",
    ),
    ["studies", STUDY_UID, "series", SERIES_UID, "instances", SOP_UID],
  );
  assert.equal(result.status, 200);
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [...bytes]);
  assert.equal(calls.length, 1);
});

test("caps metadata bytes and accepts only a fixed DICOMweb route grammar", async () => {
  const { gateway, calls } = fixture({
    upstream: () =>
      new Response("x".repeat(256), { headers: { "content-type": "application/dicom+json" } }),
  });
  const oversized = await gateway.handle(
    new Request(`https://staff.example.test/dicom-web/studies?StudyInstanceUID=${STUDY_UID}`),
    ["studies"],
  );
  assert.equal(oversized.status, 502);
  const arbitrary = await gateway.handle(
    new Request("https://staff.example.test/dicom-web/tools/find"),
    ["tools", "find"],
  );
  assert.equal(arbitrary.status, 400);
  assert.equal(calls.length, 1);
});

test("forces DICOM JSON for metadata and rejects non-JSON upstream content", async () => {
  const { gateway, calls } = fixture({
    upstream: (request) => {
      assert.equal(request.headers.get("accept"), "application/dicom+json");
      return new Response("unfiltered body", { headers: { "content-type": "multipart/related" } });
    },
  });
  const result = await gateway.handle(
    new Request(
      `https://staff.example.test/dicom-web/studies/${STUDY_UID}/series/${SERIES_UID}/instances`,
      {
        headers: { accept: "application/dicom" },
      },
    ),
    ["studies", STUDY_UID, "series", SERIES_UID, "instances"],
  );
  assert.equal(result.status, 502);
  assert.equal(await result.text(), JSON.stringify({ error: "metadata_unavailable" }));
  assert.equal(calls.length, 1);
});

test("rewrites DICOM BulkDataURI values to the authorized same-origin member route", async () => {
  const { gateway, calls } = fixture({
    upstream: () =>
      Response.json([
        {
          "0020000D": { Value: [STUDY_UID] },
          "0020000E": { Value: [SERIES_UID] },
          "00080018": { Value: [SOP_UID] },
          "7FE00010": { BulkDataURI: "http://orthanc:8042/dicom-web/internal-bulk-data" },
        },
      ]),
  });
  const metadata = await gateway.handle(
    new Request(
      `https://staff.example.test/dicom-web/studies/${STUDY_UID}/series/${SERIES_UID}/instances`,
    ),
    ["studies", STUDY_UID, "series", SERIES_UID, "instances"],
  );
  assert.equal(metadata.status, 200);
  const items = (await metadata.json()) as Record<
    string,
    Record<string, { BulkDataURI: string }>
  >[];
  const bulkUri = items[0]?.["7FE00010"]?.BulkDataURI;
  assert.equal(
    bulkUri,
    `https://staff.example.test/dicom-web/studies/${STUDY_UID}/series/${SERIES_UID}/instances/${SOP_UID}/bulkdata/7FE00010`,
  );

  const bulk = await gateway.handle(new Request(bulkUri!), [
    "studies",
    STUDY_UID,
    "series",
    SERIES_UID,
    "instances",
    SOP_UID,
    "bulkdata",
    "7FE00010",
  ]);
  assert.equal(bulk.status, 200);
  assert.match(calls[1]?.url ?? "", /\/bulkdata\/7FE00010$/);
  await bulk.arrayBuffer();
});

test("OHIF viewer requires active staff and a current Ready Report for its Study UID", async () => {
  const calls: Request[] = [];
  const proxy = createScopedOhifProxy({
    orthancOrigin: "http://orthanc:8042/",
    username: "synthetic-viewer",
    password: "synthetic-only",
    staff: {
      async requireStaffRead(cookie) {
        if (cookie !== "hanko=valid") {
          return { ok: false as const, status: 401 as const, reason: "unauthenticated" as const };
        }
        return { ok: true as const, principal: { staffUserId: STAFF_ID, role: "staff" as const } };
      },
    },
    studies: {
      async findViewableReportByStudyUid(_staffUserId, uid) {
        if (uid !== STUDY_UID) return null;
        return { studyInstanceUid: STUDY_UID } as never;
      },
    },
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return new Response("<html>synthetic OHIF shell</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  const denied = await proxy.handle(
    new Request(`https://staff.example.test/ohif/viewer?StudyInstanceUIDs=${STUDY_UID}`),
    ["viewer"],
  );
  assert.equal(denied.status, 401);

  const unrelated = await proxy.handle(
    new Request(`https://staff.example.test/ohif/viewer?StudyInstanceUIDs=1.2.840.999`, {
      headers: { cookie: "hanko=valid" },
    }),
    ["viewer"],
  );
  assert.equal(unrelated.status, 404);
  assert.equal(calls.length, 0);

  const loaded = await proxy.handle(
    new Request(`https://staff.example.test/ohif/viewer?StudyInstanceUIDs=${STUDY_UID}`, {
      headers: { cookie: "hanko=valid" },
    }),
    ["viewer"],
  );
  assert.equal(loaded.status, 200);
  assert.match(loaded.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(calls[0]?.url, `http://orthanc:8042/ohif/viewer?StudyInstanceUIDs=${STUDY_UID}`);
  assert.match(calls[0]?.headers.get("authorization") ?? "", /^Basic /);
  assert.match(await loaded.text(), /synthetic OHIF shell/);
});
