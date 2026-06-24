/**
 * FirmwareCI Checks Plugin for Gerrit
 * Provides integration between FirmwareCI job requests and Gerrit checks.
 * @version 1.1.0
 * @author FirmwareCI Team
 */

// Configuration constants
const CONFIG = Object.freeze({
  PLUGIN_VERSION: "1.1.0",
  API_VERSION: "3.12.0",
  FIRMWARE_CI_API_URL: "https://api.firmwareci.9esec.dev:8443/v0",
  FIRMWARE_CI_URL: "https://app.firmware-ci.com",
  ORGANIZATION: "ORG-NAME",
  POLLING_INTERVAL_SECONDS: 60,
});

// Job status mapping
const STATUS_MAP = Object.freeze({
  WORKFLOW: {
    queued: "SCHEDULED",
    preparing: "SCHEDULED",
    running: "RUNNING",
    succeeded: "COMPLETED",
    failed: "COMPLETED",
    aborted: "COMPLETED",
  },
  JOB: {
    succeeded: { category: "SUCCESS", color: "CYAN" },
    failed: { category: "ERROR", color: "PINK" },
    aborted: { category: "WARNING", color: "GRAY" },
    running: { category: "INFO", color: "GRAY" },
    queued: { category: "INFO", color: "GRAY" },
    preparing: { category: "INFO", color: "GRAY" },
  },
});

// Gerrit ChangeKind values that mean the code did NOT change between patchsets.
// REWORK is the only kind that signals a real code change; everything else
// (trivial rebases, message-only updates, merge first-parent updates) leaves the
// tree identical. Used to decide when checks from an older patchset may be carried
// over to a newer one that CI never ran on (e.g. the cherry-pick patchset Gerrit
// creates at submit time).
function isNonCodeChange(kind) {
  return !!kind && kind !== "REWORK";
}

/**
 * Main plugin class that handles FirmwareCI integration with Gerrit checks
 */
class FirmwareChecks {
  /**
   * Creates a new instance of the FirmwareCI checks provider
   * @param {Object} plugin - The Gerrit plugin instance
   */
  constructor(plugin) {
    this.plugin = plugin;
  }

  /**
   * Fetches check results from FirmwareCI for a Gerrit change.
   *
   * The FirmwareCI server pins job requests to the exact patchset/commit they ran
   * on. When the current patchset has no runs (typically the cherry-pick patchset
   * Gerrit creates at submit, which CI never ran on) we fall back to the most
   * recent earlier patchset that does have runs, but only across non-code-change
   * patchsets so we never present stale results for changed code.
   *
   * @param {Object} changeData - Change data from Gerrit
   * @returns {Promise<Object>} - Check response for Gerrit
   */
  async fetch(changeData) {
    try {
      // Fast path: query the patchset currently being viewed.
      let apiData;
      try {
        apiData = await this.queryChecks(
          changeData.changeNumber,
          changeData.patchsetNumber,
          changeData.repo,
          changeData.patchsetSha
        );
      } catch (error) {
        return {
          responseCode: "ERROR",
          errorMessage:
            error instanceof Error ? error.message : String(error),
        };
      }

      if (apiData?.data?.length > 0) {
        return this.mapToChecksResponse(apiData, changeData);
      }

      // Fallback: carry over runs from the newest earlier patchset that has them,
      // as long as nothing but non-code-change patchsets sit in between.
      const fallback = await this.findFallbackChecks(changeData);
      if (fallback) {
        return this.mapToChecksResponse(
          fallback.apiData,
          changeData,
          fallback.fromPatchset
        );
      }

      return { responseCode: "OK", summaryMessage: "", runs: [] };
    } catch (error) {
      console.error("Error fetching checks from FirmwareCI:", error);
      return {
        responseCode: "ERROR",
        errorMessage: `Failed to fetch checks: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /**
   * Queries the FirmwareCI gerrit-checks endpoint for one patchset.
   * @returns {Promise<Object>} - Parsed API response
   * @throws {Error} - When the API responds with a non-OK status
   */
  async queryChecks(changeNumber, patchset, project, commitHash) {
    const requestUrl = `${CONFIG.FIRMWARE_CI_API_URL}/gerrit-checks`;
    const requestBody = {
      change_number: String(changeNumber),
      patchset: String(patchset),
      project: project,
      commit_hash: commitHash,
    };

    const response = await fetch(requestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(await this.extractErrorMessage(response));
    }

    return response.json();
  }

  /**
   * Finds runs to carry over from an earlier patchset when the current one is
   * empty. Walks patchsets downward from the current one, stopping as soon as a
   * real code change (REWORK) is encountered, and returns the first earlier
   * patchset that has runs.
   * @param {Object} changeData - Change data from Gerrit
   * @returns {Promise<?{apiData: Object, fromPatchset: number}>}
   */
  async findFallbackChecks(changeData) {
    const current = Number(changeData.patchsetNumber);
    if (!Number.isFinite(current) || current <= 1) {
      return null;
    }

    let revisions;
    try {
      revisions = await this.fetchRevisions(changeData.changeNumber);
    } catch (error) {
      console.error(
        "FirmwareCI: failed to load Gerrit revisions for fallback:",
        error
      );
      return null;
    }

    for (let p = current - 1; p >= 1; p--) {
      // The step from patchset p to p+1 must be a non-code change for runs on p
      // to still describe the code at the current patchset.
      const above = revisions[p + 1];
      if (!above || !isNonCodeChange(above.kind)) {
        break;
      }

      const rev = revisions[p];
      if (!rev) continue;

      let apiData;
      try {
        apiData = await this.queryChecks(
          changeData.changeNumber,
          p,
          changeData.repo,
          rev.sha
        );
      } catch (error) {
        // A failed fallback probe is treated as "no runs", not a hard error.
        continue;
      }

      if (apiData?.data?.length > 0) {
        return { apiData, fromPatchset: p };
      }
    }

    return null;
  }

  /**
   * Loads the change's revisions from Gerrit, mapped by patchset number.
   * @param {(string|number)} changeNumber
   * @returns {Promise<Object<number, {sha: string, kind: string}>>}
   */
  async fetchRevisions(changeNumber) {
    const change = await this.plugin
      .restApi()
      .get(`/changes/${changeNumber}/?o=ALL_REVISIONS`);

    const map = {};
    const revisions = change?.revisions || {};
    for (const sha of Object.keys(revisions)) {
      const rev = revisions[sha];
      map[rev._number] = { sha, kind: rev.kind };
    }
    return map;
  }

  /**
   * Builds the error message from a non-OK API response.
   * @param {Response} response - Fetch API response object
   * @returns {Promise<string>}
   */
  async extractErrorMessage(response) {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorBody = await response.text();
      const errorData = JSON.parse(errorBody);
      errorMessage = errorData.error || errorMessage;
    } catch (e) {
      // Use default error message if parsing fails
    }
    return errorMessage;
  }

  /**
   * Maps FirmwareCI API data to Gerrit checks format
   * @param {Object} apiData - Data from FirmwareCI API
   * @param {Object} changeData - Change data from Gerrit
   * @param {number} [carriedFromPatchset] - Set when runs are carried over from
   *   an earlier (no-code-change) patchset; used to annotate the runs.
   * @returns {Object} - Check response for Gerrit
   */
  mapToChecksResponse(apiData, changeData, carriedFromPatchset) {
    // Handle empty or invalid responses
    if (!apiData?.data || apiData.data.length === 0) {
      return {
        responseCode: "OK",
        summaryMessage: "",
        runs: [],
      };
    }

    try {
      const runs = this.processJobRequests(
        apiData.data,
        changeData,
        carriedFromPatchset
      );
      return { responseCode: "OK", runs };
    } catch (error) {
      console.error("Error processing API data:", error);
      return {
        responseCode: "ERROR",
        errorMessage: `Failed to process API data: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /**
   * Processes job requests into Gerrit check runs.
   *
   * One run per workflow (job request); its individual test jobs are the run's
   * results. This matches Gerrit's run/result model: selecting a run in the Runs
   * panel narrows the Results to that workflow's tests, and the result filter box
   * matches on checkName/summary/tags across them.
   *
   * @param {Array} jobRequests - List of job requests from API
   * @param {Object} changeData - Change data from Gerrit
   * @param {number} [carriedFromPatchset]
   * @returns {Array} - List of runs for Gerrit checks
   */
  processJobRequests(jobRequests, changeData, carriedFromPatchset) {
    // Group job requests by workflow ID and assign attempt numbers so reruns of
    // a workflow collapse into attempts of one run.
    const workflowGroups = this.groupJobRequestsByWorkflow(jobRequests);
    this.assignAttemptNumbers(workflowGroups);

    return jobRequests.map((jobRequest) =>
      this.createJobRequestRun(jobRequest, changeData, carriedFromPatchset)
    );
  }

  /**
   * Groups job requests by their workflow ID
   * @param {Array} jobRequests - List of job requests
   * @returns {Object} - Job requests grouped by workflow ID
   */
  groupJobRequestsByWorkflow(jobRequests) {
    const workflowGroups = {};

    for (const jobRequest of jobRequests) {
      const workflowId = jobRequest.workflow_id || "unknown";
      if (!workflowGroups[workflowId]) {
        workflowGroups[workflowId] = [];
      }
      workflowGroups[workflowId].push(jobRequest);
    }

    return workflowGroups;
  }

  /**
   * Assigns attempt numbers to job requests based on their position in the
   * workflow group. Job requests arrive newest-first, so the newest gets the
   * highest attempt number.
   * @param {Object} workflowGroups - Job requests grouped by workflow ID
   */
  assignAttemptNumbers(workflowGroups) {
    for (const workflowId in workflowGroups) {
      const requests = workflowGroups[workflowId];
      const lastIndex = requests.length;

      requests.forEach((jobRequest, index) => {
        // Newest has highest attempt number
        jobRequest._attempt = lastIndex - index;
      });
    }
  }

  /**
   * Creates a check run for a job request (one run per workflow).
   * @param {Object} jobRequest - Job request data
   * @param {Object} changeData - Change data from Gerrit
   * @param {number} [carriedFromPatchset]
   * @returns {Object} - Check run for Gerrit
   */
  createJobRequestRun(jobRequest, changeData, carriedFromPatchset) {
    const jobStats = this.calculateJobStats(jobRequest.jobs || []);
    const statusParts = [];
    if (jobStats.succeeded > 0) statusParts.push(`${jobStats.succeeded} succeeded`);
    if (jobStats.failed > 0) statusParts.push(`${jobStats.failed} failed`);
    if (jobStats.queued > 0) statusParts.push(`${jobStats.queued} queued`);
    if (jobStats.running > 0) statusParts.push(`${jobStats.running} running`);

    let statusDescription = `${jobStats.total} jobs${
      statusParts.length > 0 ? ` (${statusParts.join(", ")})` : ""
    }`;
    let checkDescription = jobRequest.workflow_name;

    if (carriedFromPatchset) {
      const note = `results carried from patch set ${carriedFromPatchset} (no code change since)`;
      statusDescription = `${statusDescription} · ${note}`;
      checkDescription = note;
    }

    const requestId = jobRequest.id;

    const run = {
      change: changeData.changeNumber,
      patchset: changeData.patchsetNumber,
      externalId: requestId,
      checkName: `Firmware-CI: ${jobRequest.workflow_name}`,
      checkDescription,
      checkLink: encodeURI(`https://docs.firmware-ci.com`),
      statusLink: encodeURI(
        `${CONFIG.FIRMWARE_CI_URL}/${CONFIG.ORGANIZATION}/job-requests/${requestId}`
      ),
      labelName: "Verified",
      status: this.mapWorkflowStatus(jobRequest.status),
      attempt: jobRequest._attempt || 0,
      statusDescription,
      links: [this.jobRequestLink(requestId)],
      results: [],
    };

    // Add timestamps if available
    if (
      jobRequest.start_time &&
      jobRequest.start_time !== "0001-01-01T00:00:00Z"
    ) {
      run.startedTimestamp = new Date(jobRequest.start_time);
      run.scheduledTimestamp = new Date(jobRequest.start_time);

      if (jobRequest.duration) {
        run.finishedTimestamp = new Date(
          run.startedTimestamp.getTime() +
            this.parseDuration(jobRequest.duration)
        );
      }
    }

    // Add results for individual jobs (tests)
    if (jobRequest.jobs?.length > 0) {
      run.results = jobRequest.jobs.map((job) =>
        this.createJobResult(job, jobRequest._attempt)
      );
    }

    return run;
  }

  /**
   * Calculates job statistics for a job request
   * @param {Array} jobs - List of jobs
   * @returns {Object} - Job statistics
   */
  calculateJobStats(jobs) {
    const total = jobs.length;
    const succeeded = jobs.filter((job) => job.status === "succeeded").length;
    const failed = jobs.filter((job) => job.status === "failed").length;
    const queued = jobs.filter((job) => job.status === "queued").length;
    const running = jobs.filter((job) => job.status === "running").length;

    return { total, succeeded, failed, queued, running };
  }

  /**
   * Creates a result for an individual job (test) within a workflow run.
   *
   * Intentionally omits `checkName`: Gerrit's RunResult overrides the run's
   * checkName with the result's own if present, which breaks run-based filtering
   * (results are matched to their run by equal checkName). Leaving it unset makes
   * the result inherit the run's "Firmware-CI: <workflow>" name, so selecting the
   * workflow run shows its tests. The test name goes in `summary`.
   *
   * @param {Object} job - Job data
   * @param {number} attempt - Attempt number
   * @returns {Object} - Result object for Gerrit
   */
  createJobResult(job, attempt) {
    const jobStatus = job.status || "unknown";
    const statusInfo = STATUS_MAP.JOB[jobStatus] || STATUS_MAP.JOB.queued;

    return {
      externalId: job.id,
      category: statusInfo.category,
      summary: job.test?.name || "Unnamed Test",
      message: job.error || job.test?.description || "",
      attempt: attempt,
      tags: [
        {
          name: jobStatus.toUpperCase(),
          color: statusInfo.color,
        },
      ],
      links: [this.jobLink(job.id)],
    };
  }

  /**
   * Link to a job's detail page in FirmwareCI.
   * @param {string} jobId
   * @returns {Object} - Link object for Gerrit
   */
  jobLink(jobId) {
    return {
      url: `${CONFIG.FIRMWARE_CI_URL}/${CONFIG.ORGANIZATION}/jobs/${jobId}`,
      tooltip: "View job details",
      primary: true,
      icon: "EXTERNAL",
    };
  }

  /**
   * Link to a job request's (workflow) detail page in FirmwareCI.
   * @param {string} requestId
   * @returns {Object} - Link object for Gerrit
   */
  jobRequestLink(requestId) {
    return {
      url: `${CONFIG.FIRMWARE_CI_URL}/${CONFIG.ORGANIZATION}/job-requests/${requestId}`,
      tooltip: "View workflow details in FirmwareCI",
      primary: true,
      icon: "EXTERNAL",
    };
  }

  /**
   * Maps workflow status to Gerrit check status
   * @param {string} status - FirmwareCI workflow status
   * @returns {string} - Gerrit check status
   */
  mapWorkflowStatus(status) {
    return STATUS_MAP.WORKFLOW[status] || "RUNNABLE";
  }

  /**
   * Parses duration string to milliseconds
   * @param {string} duration - Duration string (e.g., "10m32s")
   * @returns {number} - Duration in milliseconds
   */
  parseDuration(duration) {
    let milliseconds = 0;
    const minutes = duration.match(/(\d+)m/);
    const seconds = duration.match(/(\d+)s/);

    if (minutes?.[1]) {
      milliseconds += parseInt(minutes[1], 10) * 60 * 1000;
    }

    if (seconds?.[1]) {
      milliseconds += parseInt(seconds[1], 10) * 1000;
    }

    return milliseconds;
  }
}

// Install the plugin
window.Gerrit.install(async (plugin) => {
  const firmwareChecks = new FirmwareChecks(plugin);

  plugin
    .checks()
    .register(
      { fetch: (change) => firmwareChecks.fetch(change) },
      { fetchPollingIntervalSeconds: CONFIG.POLLING_INTERVAL_SECONDS }
    );
});
