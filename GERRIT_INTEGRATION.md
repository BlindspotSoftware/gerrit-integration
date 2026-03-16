# FirmwareCI Gerrit Integration Guide

Integration of [BlindspotSoftware/gerrit-integration](https://github.com/BlindspotSoftware/gerrit-integration) with [review.coreboot.org](https://review.coreboot.org/admin/repos/coreboot,general), using [BlindspotSoftware/coreboot-qa](https://github.com/BlindspotSoftware/coreboot-qa) as the FirmwareCI project.

## Overview

Two things need to be set up:

1. **Jenkins** — builds coreboot and calls `job-request-script.sh` to submit artifacts to FirmwareCI
2. **Gerrit plugin** — `checks-plugin.js` displays FirmwareCI results in the Gerrit Checks tab

There are two approaches for the Jenkins pipeline depending on whether a `Jenkinsfile` can live in the coreboot repo:

- [**Option A**](#option-a-jenkinsfile-in-the-repo) — Jenkinsfile stored in the repo (pipeline as code)
- [**Option B**](#option-b-no-jenkinsfile-in-the-repo) — Pipeline defined externally in a separate repo or Jenkins UI

---

## Part 1: Gerrit Plugin (checks-plugin.js)

Displays FirmwareCI test results directly in Gerrit's **Checks** tab on each patchset.

### 1.1 Get the plugin

```bash
curl -o checks-plugin.js https://raw.githubusercontent.com/BlindspotSoftware/gerrit-integration/main/checks-plugin.js
```

### 1.2 Configure the plugin

Edit the `CONFIG` object inside `checks-plugin.js`:

```js
const CONFIG = {
  FIRMWARE_CI_API_URL: "https://api.firmwareci.9esec.dev:8443/v0",
  FIRMWARE_CI_URL: "https://app.firmware-ci.com",
  ORGANIZATION: "coreboot-qa",
};
```

### 1.3 Install on the Gerrit server

Copy the plugin to the Gerrit plugins directory:

```bash
cp checks-plugin.js /path/to/gerrit/plugins/
```

Install via the Gerrit plugin HTTP:

```bash
curl -X POST --user admin:password \
  'https://review.coreboot.org/a/plugins/checks-plugin.js' \
  --data-binary @checks-plugin.js
```
---

## Part 2: Jenkins Prerequisites

### 2.1 Required Jenkins plugins

- **Gerrit Trigger Plugin** — listens for patchset events from Gerrit
- **Git Plugin**
- **Credentials Plugin**

#### Installing via Jenkins UI

1. Go to **Manage Jenkins → Plugins → Available plugins**
2. Search for and tick each plugin:
   - `Gerrit Trigger`
   - `Git` (usually pre-installed)
   - `Credentials` (usually pre-installed)
3. Install

### 2.2 Bot account on review.coreboot.org

The "bot" is a dedicated Gerrit service account used by Jenkins to:

- Clone/fetch the coreboot repo and specific patchset refs over SSH
- Post `Verified` vote results back to Gerrit after the pipeline finishes

This is separate from your personal Gerrit account. It should have a machine-readable name like `jenkins-bot` or `firmwareci-bot`.

#### Creating the bot account

1. Register a new account at `https://review.coreboot.org/register`
2. Use a service account email (e.g. `jenkins@your-org.com`)
3. Log in as the bot account and go to **Settings → SSH Keys**
4. Generate a dedicated SSH keypair on the Jenkins server:
   ```bash
   ssh-keygen -t ed25519 -C "jenkins-bot@your-org.com" -f ~/.ssh/gerrit_bot
   ```
5. Paste the **public key** (`~/.ssh/gerrit_bot.pub`) into Gerrit → **Settings → SSH Keys**
6. Add the **private key** (`~/.ssh/gerrit_bot`) to Jenkins:
   - **Manage Jenkins → Credentials → (global)** → Add **SSH Username with private key**
   - Username: `jenkins-bot` (must match the Gerrit account username)
   - Private key: paste the contents of `~/.ssh/gerrit_bot`

#### Granting permissions

The bot needs `Label-Verified` permission to post vote results. On a private Gerrit instance, grant this in the project's **Access** settings:

1. Go to `https://your-gerrit/admin/repos/coreboot,access`
2. Under **Reference: refs/heads/***  → Add permission → **Label Verified**
3. Set range `-1` to `+1`, assign to the bot's group or directly to the bot account

#### Referencing the bot in the Jenkinsfile

Replace `your-bot` in the checkout URL with the bot's Gerrit username:

```groovy
url: 'ssh://jenkins-bot@review.coreboot.org:29418/coreboot'
```

And use the SSH credential ID you created above in the `userRemoteConfigs`:

```groovy
userRemoteConfigs: [[
    credentialsId: 'gerrit-bot-ssh-key',
    url: 'ssh://jenkins-bot@review.coreboot.org:29418/coreboot',
    refspec: '${GERRIT_REFSPEC}'
]]
```

### 2.3 Configure Gerrit Trigger in Jenkins

Go to **Manage Jenkins → Configure System → Gerrit Trigger** and fill in:

| Field        | Value                          |
|--------------|-------------------------------|
| Hostname     | `review.coreboot.org`          |
| Frontend URL | `https://review.coreboot.org/` |
| SSH Port     | `29418`                        |
| Username     | the bot account username       |
| SSH Key      | `gerrit-bot-ssh-key` (see 2.2) |

### 2.4 Add FirmwareCI credentials in Jenkins

Go to **Manage Jenkins → Credentials → (global)** → Add a **Secret text** credential:

- **ID:** `firmwareci-token`
- **Secret:** your FirmwareCI API token

---

## Option A: Jenkinsfile in the Repo

Store the following `Jenkinsfile` at the root of the coreboot repo. Jenkins checks it out as part of the pipeline and uses it directly.

```groovy
pipeline {
    agent {
        docker {
            image 'ubuntu:24.04'
            args '-u root'
        }
    }

    options {
        timestamps()
        timeout(time: 60, unit: 'MINUTES')
        skipDefaultCheckout()
    }

    triggers {
        gerrit customUrl: '',
        gerritProjects: [
            [
                branches: [[compareType: 'ANT', pattern: '**']],
                compareType: 'PLAIN',
                pattern: 'coreboot'   // must match the Gerrit repo name exactly
            ]
        ],
        triggerOnEvents: [
            patchsetCreated(excludeDrafts: true)
        ]
    }

    stages {
        stage('Install Git') {
            steps {
                sh '''
                    apt-get update
                    apt-get install -y git curl
                '''
            }
        }

        stage('Checkout') {
            steps {
                checkout([
                    $class: 'GitSCM',
                    branches: [[name: 'FETCH_HEAD']],
                    extensions: [
                        [$class: 'CleanBeforeCheckout'],
                        [$class: 'SubmoduleOption',
                        disableSubmodules: false,
                        recursiveSubmodules: true,
                        parentCredentials: true]
                    ],
                    userRemoteConfigs: [[
                        url: 'ssh://your-bot@review.coreboot.org:29418/coreboot',
                        refspec: '${GERRIT_REFSPEC}'
                    ]]
                ])

                sh 'git config --global --add safe.directory "*"'
                sh 'git submodule update --init --recursive'
            }
        }

        stage('Install Dependencies') {
            steps {
                sh '''
                    apt-get update
                    apt-get install -y \
                        bison build-essential curl flex git gnat \
                        libncurses5-dev m4 zlib1g-dev libelf-dev nasm \
                        uuid-dev imagemagick python3 python-is-python3
                '''
            }
        }

        stage('Build Toolchain') {
            when {
                expression {
                    return !fileExists('./util/crossgcc/xgcc/bin/i386-elf-gcc')
                }
            }
            steps {
                sh 'make crossgcc-i386 CPUS=$(nproc)'
            }
        }

        stage('Prepare Config') {
            steps {
                sh 'cp configs/config.emulation_qemu_x86_i440fx ./.config'
                sh 'make olddefconfig'
            }
        }

        stage('Build') {
            steps {
                sh 'make -j$(nproc)'
            }
        }

        stage('Deploy to FirmwareCI') {
            steps {
                sh '''
                    curl -o job-request-script.sh https://raw.githubusercontent.com/BlindspotSoftware/gerrit-integration/main/job-request-script.sh
                    chmod +x job-request-script.sh
                '''

                withCredentials([
                    string(credentialsId: 'firmwareci-token', variable: 'FWCI_TOKEN'),
                ]) {
                    sh '''
                        export FWCI_PROJECT_LINK=github.com/BlindspotSoftware/coreboot-qa
                        export FWCI_WORKFLOW_NAME=QEMU
                        export BINARIES="Binary=build/coreboot.rom"
                        ./job-request-script.sh
                    '''
                }
            }
        }
    }
}
```

**Jenkins job setup:**

1. **New Item** → Multibranch Pipeline (or Pipeline)
2. Under **Pipeline**, select **Pipeline script from SCM**
3. SCM: Git, URL: `ssh://your-bot@review.coreboot.org:29418/coreboot`
4. Script Path: `Jenkinsfile`
5. Enable **Gerrit Trigger** under Build Triggers

---

## Alternative: Inline pipeline script in Jenkins UI

For a minimal setup with no external repo:

1. **New Item** → Pipeline
2. Under **Pipeline**, select **Pipeline script**
3. Paste the full Groovy pipeline directly into the text box
4. Enable **Gerrit Trigger** under Build Triggers

---

The `FWCI_WORKFLOW_NAME=QEMU` in the pipeline maps to the `workflows/qemu/` directory in this repo.

---

## Deploy Stage Variables

| Variable             | Value in this setup                        | Description                                             |
|----------------------|--------------------------------------------|---------------------------------------------------------|
| `FWCI_PROJECT_LINK`  | `github.com/BlindspotSoftware/coreboot-qa` | VCS repo containing FirmwareCI workflow configs         |
| `FWCI_WORKFLOW_NAME` | `QEMU`                                     | Workflow to run (maps to `.firmwareci/workflows/qemu/`) |
| `BINARIES`           | `Binary=build/coreboot.rom`                | Firmware artifact to submit for testing                 |
| `FWCI_TOKEN`         | injected via Jenkins credentials           | FirmwareCI API authentication token                     |

---

## End-to-End Flow

```text
Developer pushes patchset to review.coreboot.org/coreboot
        ↓
Gerrit Trigger Plugin fires → Jenkins job starts
        ↓
Jenkins checks out the patchset via GERRIT_REFSPEC
        ↓
Builds coreboot (crossgcc toolchain + make)
        ↓
job-request-script.sh uploads coreboot.rom → FirmwareCI
        ↓
FirmwareCI runs QEMU workflow (boot, PCI, warm-reboot tests)
        ↓
checks-plugin.js polls FirmwareCI every 60s
        ↓
Results appear in Gerrit Checks tab on the patchset
```

---
