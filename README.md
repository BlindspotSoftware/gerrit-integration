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
   export FWCI_WORKFLOW_ID="your-workflow-id"
   export BINARIES="Binary=path/to/firmware.bin"
   export COMMIT_HASH="$(git rev-parse HEAD)"
   ```

2. **Run job-request:**

   ```bash
   ./job-request-script.sh
   ```

## Environment Variables

### Required

| Variable           | Description                                   |
| ------------------ | --------------------------------------------- |
| `FWCI_TOKEN`       | FirmwareCI authentication token               |
| `FWCI_WORKFLOW_ID` | Workflow ID to execute                        |
| `BINARIES`         | Key-value pairs of template names to binary paths |
| `COMMIT_HASH`      | Git commit hash                               |

### Gerrit Integration (Optional)

| Variable           | Description                |
| ------------------ | -------------------------- |
| `CHANGE_ID`        | Gerrit change ID           |
| `PROJECT`          | Gerrit project name        |
| `CHANGE_NUMBER`    | Gerrit change number       |
| `CURRENT_REVISION` | Current revision           |
| `PATCHSET`         | Patchset number            |

### Alternative Authentication

| Variable        | Description                                              |
| --------------- | -------------------------------------------------------- |
| `FWCI_EMAIL`    | Account email (instead of token)                         |
| `FWCI_PASSWORD` | Account password (instead of token)                      |
| `FWCI_API`      | API URL (default: <https://api.firmwareci.9esec.dev:8443>) |

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
            string(credentialsId: 'firmwareci-token', variable: 'FWCI_TOKEN'),
            string(credentialsId: 'firmwareci-workflow-id', variable: 'FWCI_WORKFLOW_ID')
        ]) {
            sh '''
                export COMMIT_HASH="${GERRIT_PATCHSET_REVISION}"
                export BINARIES="Binary=build/firmware.bin"
                export CHANGE_ID="${GERRIT_CHANGE_ID:-}"
                export PROJECT="${GERRIT_PROJECT:-}"
                export CHANGE_NUMBER="${GERRIT_CHANGE_NUMBER:-}"
                export CURRENT_REVISION="${GERRIT_PATCHSET_REVISION:-}"
                export PATCHSET="${GERRIT_PATCHSET_NUMBER:-}"

                ./job-request-script.sh
            '''
        }
    }
}
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
