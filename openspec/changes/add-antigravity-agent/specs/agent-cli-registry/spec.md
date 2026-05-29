## ADDED Requirements

### Requirement: Antigravity CLI is an available built-in agent

The application SHALL offer Antigravity CLI as a built-in default agent, identified
by the command `agy`, alongside the existing Claude Code, Codex, Gemini CLI,
OpenCode, and Copilot agents. Adding Antigravity SHALL NOT remove or alter the
Gemini CLI agent.

#### Scenario: Antigravity appears when its binary is installed

- **WHEN** the application lists available agents and `agy` is resolvable on the
  user's PATH
- **THEN** an agent named "Antigravity CLI" is presented as available for selection

#### Scenario: Antigravity is shown unavailable when its binary is missing

- **WHEN** the application lists available agents and `agy` is not resolvable on the
  user's PATH
- **THEN** the Antigravity CLI agent is marked not installed and cannot be launched

#### Scenario: Gemini CLI remains offered

- **WHEN** the application lists available agents
- **THEN** the Gemini CLI agent is still present and unchanged

### Requirement: Antigravity launch, resume, and skip-permission arguments

The application SHALL launch the Antigravity CLI interactively with no extra
arguments, SHALL resume the most recent conversation using `-c` when a task is
resumed, and SHALL pass `--dangerously-skip-permissions` only when the task opts
into skipping permission prompts.

#### Scenario: Fresh interactive launch

- **WHEN** a new task starts with the Antigravity agent and skip-permissions is off
- **THEN** the CLI is started as `agy` with no resume or skip-permission arguments

#### Scenario: Resuming a previous session

- **WHEN** a task using the Antigravity agent is resumed
- **THEN** the CLI is started with its resume argument `-c`

#### Scenario: Launch with permissions skipped

- **WHEN** a task using the Antigravity agent is started with skip-permissions enabled
- **THEN** `--dangerously-skip-permissions` is included in the launch arguments

### Requirement: Antigravity config sharing for isolated tasks

For Docker-isolated tasks, the application SHALL treat `~/.gemini/antigravity-cli` as
the Antigravity config directory eligible for the shared-auth mount. The application
SHALL NOT claim a working Docker authentication path for Antigravity: its login
credentials live in the host OS keyring, which is not reachable from the container,
and `agy` provides no API-key environment fallback, so Antigravity is supported only
as a native (non-Docker) task.

#### Scenario: Config directory is shared into the container

- **WHEN** a Docker-isolated Antigravity task runs with shared agent auth enabled
- **THEN** the host `~/.gemini/antigravity-cli` directory is bind-mounted into the
  container's home so settings and plugins are available to the in-container agent

#### Scenario: Docker isolation does not provide authentication

- **WHEN** a Docker-isolated Antigravity task is launched without host keyring access
- **THEN** the agent cannot authenticate inside the container, and the supported path
  is to run the Antigravity task natively instead

### Requirement: Antigravity is runnable in the bundled Docker image

The bundled Docker agent image SHALL include the `agy` binary on its PATH so that
Docker-isolated tasks can launch the Antigravity agent.

#### Scenario: agy is present in the image

- **WHEN** a Docker-isolated task selects the Antigravity agent using the bundled image
- **THEN** `agy` resolves on the container PATH and the agent process starts
