# FirmwareCI Gerrit Integration

This repository provides CI/CD pipeline integration with Gerrit for automated firmware testing.

## Prerequisites

- Gerrit repository linked with FirmwareCI ([Integration Guide](https://docs.firmware-ci.com/usage/2_repository_setup/index.html))


## Components

### Deployment Script (`job-request-script.sh`)

Automates firmware binary job-request to FirmwareCI, handling authentication, upload, and job creation with Gerrit metadata.

### Checks Plugin (`checks-plugin.js`)

Displays FirmwareCI job results directly in Gerrit's Checks tab with real-time status updates.

## Quick Start

1. **Set required environment variables:**

   ```bash
   export FWCI_TOKEN="your-token"
   export FWCI_WORKFLOW_NAME="my-firmware-workflow"
   export BINARIES="Binary=path/to/firmware.bin"
   ```

2. **Run job-request:**

   ```bash
   ./job-request-script.sh
   ```

## Environment Variables

### Required

| Variable                   | Description                                                          |
| -------------------------- | -------------------------------------------------------------------- |
| `FWCI_TOKEN`               | FirmwareCI authentication token                                      |
| `FWCI_WORKFLOW_NAME`       | Name of the FirmwareCI workflow (preferred over `FWCI_WORKFLOW_ID`)  |
| `FWCI_WORKFLOW_ID`         | *(Deprecated)* Workflow ULID — use `FWCI_WORKFLOW_NAME` instead      |
| `GERRIT_PATCHSET_REVISION` | Git commit hash — set automatically by the Gerrit Trigger plugin     |

Workflow reference: provide either `FWCI_WORKFLOW_NAME` or `FWCI_WORKFLOW_ID` (mutually exclusive; exactly one must be set).

### Optional

| Variable            | Description                                                                                                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BINARIES`          | Semicolon-separated `template=path` pairs. Paths may be local files, HTTP/S URLs, or S3 URIs. Example: `fw=./build/fw.bin;bl=./build/bl.bin`                                                                                                                                                        |
| `FWCI_PROJECT_LINK` | Repo containing the FirmwareCI workflow config — required when it differs from the repo being tested. Copy from the Workflows page (copy button next to the project name). Accepts with or without scheme; `org/repo` is sufficient for same-org repos. Example: `github.com/my-org/firmware-config` |
| `FWCI_EMAIL`        | Account email (alternative to `FWCI_TOKEN`)                                                                                                                                                                                                                                                          |
| `FWCI_PASSWORD`     | Account password (alternative to `FWCI_TOKEN`)                                                                                                                                                                                                                                                       |
| `FWCI_API`          | API endpoint. Default: `https://api.firmwareci.9esec.dev:8443`                                                                                                                                                                                                                                       |

### Gerrit Metadata (Optional)

These are set automatically by the Gerrit Trigger plugin when running in Jenkins.

| Variable                   | Description          |
| -------------------------- | -------------------- |
| `GERRIT_CHANGE_ID`         | Gerrit change ID     |
| `GERRIT_PROJECT`           | Gerrit project name  |
| `GERRIT_CHANGE_NUMBER`     | Gerrit change number |
| `GERRIT_PATCHSET_NUMBER`   | Patchset number      |

### Plugin Configuration

Before installing the plugin, configure the `CONFIG` object in `checks-plugin.js`:

```javascript
const CONFIG = Object.freeze({
  PLUGIN_VERSION: "1.0.0",
  API_VERSION: "3.12.0",
  FIRMWARE_CI_API_URL: "https://api.firmwareci.9esec.dev:8443/v0",
  FIRMWARE_CI_URL: "https://app.firmware-ci.com",
  ORGANIZATION: "your-organization-name",  // Replace with your FirmwareCI organization name
  POLLING_INTERVAL_SECONDS: 60,
});
```

**Required Configuration:**

- `ORGANIZATION`: Your FirmwareCI organization name (used to generate links in the UI)

## Jenkins Integration

### Gerrit Trigger Setup

Configure your Jenkins pipeline to automatically trigger on Gerrit patchset creation:

```groovy
triggers {
    gerrit customUrl: '',
    gerritProjects: [
        [
            branches: [[compareType: 'ANT', pattern: '**']],
            compareType: 'PLAIN',
            pattern: 'your-project-name'
        ]
    ],
    triggerOnEvents: [
        patchsetCreated(excludeDrafts: true)
    ]
}
```

### FirmwareCI Deployment Stage

Add this stage to your Jenkins pipeline to deploy firmware binaries to FirmwareCI:

```groovy
stage('Deploy to FirmwareCI') {
    steps {
        script {
            sh '''
                curl -o job-request-script.sh https://raw.githubusercontent.com/BlindspotSoftware/gerrit-integration/main/job-request-script.sh
                chmod +x job-request-script.sh
            '''
        }

        withCredentials([
            string(credentialsId: 'firmwareci-token', variable: 'FWCI_TOKEN')
        ]) {
            sh '''
                export FWCI_WORKFLOW_NAME="my-firmware-workflow"
                export BINARIES="Binary=build/firmware.bin"
                ./job-request-script.sh
            '''
        }
    }
}
```

### Cross-Repository Workflow Config

When the FirmwareCI workflow config lives in a different repository, add `FWCI_PROJECT_LINK`:

```groovy
sh '''
    export FWCI_WORKFLOW_NAME="my-firmware-workflow"
    export FWCI_PROJECT_LINK="github.com/my-org/firmware-config"
    ...
    ./job-request-script.sh
'''
```

## Plugin Installation

### Prerequisites

- Gerrit 3.12+
- Gerrit repository linked with FirmwareCI ([Integration Guide](https://docs.firmware-ci.com/usage/2_repository_setup/index.html))
- Deployment script configured with Gerrit metadata

### Install

```bash
cp checks-plugin.js /path/to/gerrit/plugins/firmware-ci-checks.js
```

## Troubleshooting

### Common Issues

- **Authentication fails**: Verify `FWCI_TOKEN` is valid
- **File not found**: Check `BINARIES` paths exist and are accessible
- **No results in Checks tab**: Verify Gerrit metadata variables are set in the script

### Support

- [FirmwareCI Documentation](https://docs.firmware-ci.com/)
- [Gerrit Checks API](https://gerrit-review.googlesource.com/Documentation/pg-plugin-checks-api.html)
