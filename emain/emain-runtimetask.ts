// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Supervision of the detached runtime on Windows (ADR-0006): a per-user
// Scheduled Task (logon trigger + restart on failure) plays the role systemd
// has on Linux. Installed idempotently on app startup — that is the automatic
// migration path for existing installs; no elevation needed for per-user tasks.

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getRuntimeSpawnArgs, RuntimeTaskName } from "./emain-runtime";
import { getWaveSrvPath } from "./emain-platform";

function xmlEscape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildTaskArguments(): string {
    return getRuntimeSpawnArgs()
        .map((arg) => (arg.startsWith("--") ? arg : `"${arg}"`))
        .join(" ");
}

function buildTaskXml(userId: string): string {
    const command = getWaveSrvPath();
    const args = buildTaskArguments();
    return `<?xml version="1.0"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Nexus Workbench detached runtime (wavesrv). Managed by the app; safe to disable if you no longer use Nexus Workbench.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function queryTaskXml(): string {
    try {
        return child_process
            .execFileSync("schtasks", ["/query", "/tn", RuntimeTaskName, "/xml"], { encoding: "utf8" })
            .toString();
    } catch (e) {
        return null;
    }
}

export function ensureRuntimeTask() {
    if (process.platform !== "win32") {
        return;
    }
    try {
        const currentXml = queryTaskXml();
        const wavesrvPath = getWaveSrvPath();
        if (currentXml != null && currentXml.includes(xmlEscape(wavesrvPath))) {
            return;
        }
        const userId = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : os.userInfo().username;
        const xml = buildTaskXml(userId);
        const xmlPath = path.join(os.tmpdir(), `nexus-runtime-task-${process.pid}.xml`);
        fs.writeFileSync(xmlPath, xml, "utf8");
        try {
            child_process.execFileSync("schtasks", ["/create", "/tn", RuntimeTaskName, "/xml", xmlPath, "/f"], {
                stdio: "ignore",
            });
            console.log(`scheduled task ${RuntimeTaskName} ${currentXml == null ? "installed" : "updated"}`);
        } finally {
            fs.rmSync(xmlPath, { force: true });
        }
    } catch (e) {
        console.log("error ensuring runtime scheduled task (runtime will run unsupervised)", e);
    }
}
