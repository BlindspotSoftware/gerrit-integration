/**
 * FirmwareCI Checks Plugin for Gerrit
 * Provides integration between FirmwareCI job requests and Gerrit checks.
 * @version 1.0.0
 * @author FirmwareCI Team
 */

// Configuration constants
const CONFIG = Object.freeze({
  PLUGIN_VERSION: "1.0.0",
  API_VERSION: "3.12.0",
  FIRMWARE_CI_API_URL: "https://api.firmwareci.9esec.dev:8443/v0",
  FIRMWARE_CI_URL: "https://app.firmware-ci.com/app",
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
   * Fetches check results from FirmwareCI API
   * @param {Object} changeData - Change data from Gerrit
   * @returns {Promise<Object>} - Check response for Gerrit
   */
  async fetch(changeData) {
    try {
      const requestUrl = `${CONFIG.FIRMWARE_CI_API_URL}/gerrit-checks`;
      const requestBody = {
        change_number: changeData.changeNumber.toString(),
        patchset: changeData.patchsetNumber.toString(),
        project: changeData.repo,
        commit_hash: changeData.patchsetSha,
      };

      const response = await fetch(requestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        return this.handleErrorResponse(response);
      }

      const apiData = await response.json();
      return this.mapToChecksResponse(apiData, changeData);
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
   * Handles error responses from the API
   * @param {Response} response - Fetch API response object
   * @returns {Object} - Error response for Gerrit
   */
  async handleErrorResponse(response) {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorBody = await response.text();
      const errorData = JSON.parse(errorBody);
      errorMessage = errorData.error || errorMessage;
    } catch (e) {
      // Use default error message if parsing fails
    }
    return {
      responseCode: "ERROR",
      errorMessage,
    };
  }

  /**
   * Maps FirmwareCI API data to Gerrit checks format
   * @param {Object} apiData - Data from FirmwareCI API
   * @param {Object} changeData - Change data from Gerrit
   * @returns {Object} - Check response for Gerrit
   */
  mapToChecksResponse(apiData, changeData) {
    // Handle empty or invalid responses
    if (!apiData?.data || apiData.data.length === 0) {
      return {
        responseCode: "OK",
        summaryMessage: "",
        runs: [],
      };
    }

    try {
      const runs = this.processJobRequests(apiData.data, changeData);
      console.log(runs);
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
   * Processes job requests to generate Gerrit check runs
   * @param {Array} jobRequests - List of job requests from API
   * @param {Object} changeData - Change data from Gerrit
   * @returns {Array} - List of runs for Gerrit checks
   */
  processJobRequests(jobRequests, changeData) {
    // Group job requests by workflow ID and assign attempt numbers
    const workflowGroups = this.groupJobRequestsByWorkflow(jobRequests);
    this.assignAttemptNumbers(workflowGroups);

    // Build check runs from job requests
    return jobRequests.map((jobRequest) =>
      this.createJobRequestRun(jobRequest, changeData)
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
   * Assigns attempt numbers to job requests based on their position in the workflow group
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
   * Creates a check run for a job request
   * @param {Object} jobRequest - Job request data
   * @param {Object} changeData - Change data from Gerrit
   * @returns {Object} - Check run for Gerrit
   */
  createJobRequestRun(jobRequest, changeData) {
    const jobStats = this.calculateJobStats(jobRequest.jobs || []);
    let statusParts = [];
    if (jobStats.succeeded > 0)
      statusParts.push(`${jobStats.succeeded} succeeded`);
    if (jobStats.failed > 0) statusParts.push(`${jobStats.failed} failed`);
    if (jobStats.queued > 0) statusParts.push(`${jobStats.queued} queued`);
    if (jobStats.running > 0) statusParts.push(`${jobStats.running} running`);

    const statusDescription = `${jobStats.total} jobs${
      statusParts.length > 0 ? ` (${statusParts.join(", ")})` : ""
    }`;
    const requestId = jobRequest.id;

    const run = {
      change: changeData.changeNumber,
      patchset: changeData.patchsetNumber,
      externalId: requestId,
      checkName: `Firmware-CI: ${jobRequest.workflow_name}`,
      checkDescription: `${jobRequest.workflow_name}`,
      checkLink: encodeURI(`https://docs.firmware-ci.com`),
      statusLink: encodeURI(
        `${CONFIG.FIRMWARE_CI_URL}/job-requests/${requestId}`
      ),
      labelName: "Verified",
      status: this.mapWorkflowStatus(jobRequest.status),
      attempt: jobRequest._attempt || 0,
      statusDescription,
      links: [this.createJobRequestLink(requestId)],
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

    // Add results for individual jobs
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
   * Creates a link for a job request
   * @param {string} requestId - Job request ID
   * @returns {Link} - Link object for Gerrit
   */
  createJobRequestLink(requestId) {
    return {
      url: `${CONFIG.FIRMWARE_CI_URL}/job-requests/${requestId}`,
      tooltip: "View workflow details in FirmwareCI",
      primary: true,
      icon: "EXTERNAL",
    };
  }

  /**
   * Creates a result for an individual job
   * @param {Object} job - Job data
   * @returns {Object} - Result object for Gerrit
   */
  createJobResult(job, attempt) {
    const jobStatus = job.status || "unknown";
    const statusInfo = STATUS_MAP.JOB[jobStatus] || STATUS_MAP.JOB.queued;

    return {
      externalId: job.id,
      checkName: job.test?.name || "Unnamed Test",
      category: statusInfo.category,
      summary: job.error || job.test?.description || "",
      attempt: attempt,
      tags: [
        {
          name: jobStatus.toUpperCase(),
          color: statusInfo.color,
        },
      ],
      links: [
        {
          url: `${CONFIG.FIRMWARE_CI_URL}/jobs/${job.id}`,
          tooltip: "View job details",
          primary: true,
          icon: "EXTERNAL",
        },
      ],
    };
  }

  /**
   * Handles errors from rerun API calls
   * @param {Response} response - Fetch API response object
   * @returns {Object} - Error response for Gerrit
   */
  async handleRerunError(response) {
    const errorText = await response.text();
    let errorMessage = errorText;

    try {
      const errorData = JSON.parse(errorText);
      errorMessage = errorData.error || errorText;
    } catch (e) {
      // Use default error message if parsing fails
    }

    return { message: `Failed to rerun job: ${errorMessage}` };
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
