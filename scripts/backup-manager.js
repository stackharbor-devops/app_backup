function BackupManager(config) {
    /**
     * Implements backup management of the environment data
     * @param {{
     *  session : {String}
     *  baseUrl : {String}
     *  uid : {Number}
     *  cronTime : {String}
     *  scriptName : {String}
     *  envName : {String}
     *  envAppid : {String}
     *  storageNodeId : {String}
     *  backupExecNode : {String}
     *  [storageEnv] : {String}
     *  [backupCount] : {String}
     * }} config
     * @constructor
     */

    var Response = com.hivext.api.Response,
        EnvironmentResponse = com.hivext.api.environment.response.EnvironmentResponse,
        ScriptEvalResponse = com.hivext.api.development.response.ScriptEvalResponse,
        Transport = com.hivext.api.core.utils.Transport,
        Random = com.hivext.api.utils.Random,
        SimpleDateFormat = java.text.SimpleDateFormat,
        StrSubstitutor = org.apache.commons.lang3.text.StrSubstitutor,
	Scripting = com.hivext.api.development.Scripting,
        LoggerFactory = org.slf4j.LoggerFactory,
        LoggerName = "scripting.logger.backup-addon:" + config.envName,
        Logger = LoggerFactory.getLogger(LoggerName),

        me = this,
        nodeManager,
        session;

    config = config || {};
    session = config.session;
    nodeManager = new NodeManager(config.envName);

    me.invoke = function (action) {
        var actions = {
            "install"         : me.install,
            "uninstall"       : me.uninstall,
            "backup"          : me.backup,
            "restore"         : me.restore
        };

        if (!actions[action]) {
            return {
                result : Response.ERROR_UNKNOWN,
                error : "unknown action [" + action + "]"
            }
        }

        return actions[action].call(me);
    };

    me.install = function () {
        var resp;

        return me.exec([
	    [ me.cmd, [
                'echo $(date) %(envName) "Creating the backup task for %(envName) with the backup count %(backupCount), backup schedule %(cronTime) and backup storage env %(storageEnv)" | tee -a %(backupLogFile)'
            ], {
                nodeId : config.backupExecNode,
                envName : config.envName,
                cronTime : config.cronTime,
                storageEnv : config.storageEnv,
                backupCount : config.backupCount,
                backupLogFile : "/var/log/backup_addon.log"
            }],
            [ me.createScript   ],
            [ me.clearScheduledBackups ],
            [ me.scheduleBackup ]
        ]);
    };

    me.uninstall = function () {
        return me.exec(me.clearScheduledBackups);
    };

    me.checkCurrentlyRunningBackup = function () {
	var resp = me.exec([
            [ me.cmd, [
                'pgrep -f "%(envName)"_backup-logic.sh 1>/dev/null && echo "Running"; true'
            ], {
                nodeId : config.backupExecNode,
                envName : config.envName
            }]
        ]);
	if (resp.responses[0].out == "Running") {
	    return {
                result : Response.ERROR_UNKNOWN,
                error : "Another backup process is already running"
            }
	} else {
	    return { "result": 0};
	}
    }

    me.backup = function () {
        var backupType,
            isManual = !getParam("task");

        if (isManual) {
            backupType = "manual";
        } else {
            backupType = "auto";
        }

        return me.exec([
            [ me.checkEnvStatus ],
            [ me.checkStorageEnvStatus ],
	    [ me.checkCurrentlyRunningBackup ],
            [ me.removeMounts ],
            [ me.addMountForBackupRestore ],
            [ me.cmd, [
		'[ -f /root/%(envName)_backup-logic.sh ] && rm -f /root/%(envName)_backup-logic.sh || true',
                'wget -O /root/%(envName)_backup-logic.sh %(baseUrl)/scripts/backup-logic.sh',
                'bash /root/%(envName)_backup-logic.sh backup %(baseUrl) %(backupType) %(nodeId) %(backupLogFile) %(envName) %(backupCount) %(appPath)'
            ], {
                nodeId : config.backupExecNode,
                envName : config.envName,
                appPath : "/var/www/webroot/ROOT",
                backupCount : config.backupCount,
                backupLogFile : "/var/log/backup_addon.log",
                baseUrl : config.baseUrl,
                backupType : backupType
            }],
        [ me.removeMounts ]
        ]);
    };

    me.restore = function () {
        return me.exec([
            [ me.checkEnvStatus ],
            [ me.checkStorageEnvStatus ],
	    [ me.checkCurrentlyRunningBackup ],
            [ me.removeMounts ],
            [ me.addMountForBackupRestore ],
            [ me.cmd, [
		'echo $(date) %(envName) Restoring the snapshot $(cat /root/.backupid)',
                'jem service stop',
                'SNAPSHOT_ID=$(RESTIC_PASSWORD="%(envName)" restic -r /opt/backup/ snapshots|grep $(cat /root/.backupid)|awk \'{print $1}\')',
                '[ -n "${SNAPSHOT_ID}" ] || false',
		'current_time=$(date +"%Y%m%d_%H%M%S")',
	        'TEMPORARY_RESTORE=$(cat /root/.temporaryrestore); if (( ! $TEMPORARY_RESTORE )); then ENV_RESTORE_TARGET="/"; else mkdir /var/www/webroot/$current_time; ENV_RESTORE_TARGET="/var/www/webroot/$current_time/"; fi',
                'RESTIC_PASSWORD="%(envName)" restic -r /opt/backup/ restore ${SNAPSHOT_ID} --target $ENV_RESTORE_TARGET --path $ENV_RESTORE_TARGET'
          //      'RESTIC_PASSWORD="%(envName)" restic -r /opt/backup/ restore ${SNAPSHOT_ID} --target /'
            ], {
                nodeGroup : "cp",
                envName : config.envName
            }],
            [ me.cmd, [
                'rm -f /root/.backupid',
                'rm -f /root/.temporaryrestore',
                'jem service start'
            ], {
                nodeGroup : "cp",
                envName : config.envName
            }],
        [ me.removeMounts ]
    ]);
    }

    me.addMountForBackupRestore = function addMountForBackupRestore() {
        var resp = jelastic.env.file.AddMountPointByGroup(config.envName, session, "cp", "/opt/backup", 'nfs4', null, '/data/' + config.envName, config.storageNodeId, 'AppBackupRestore', false);
        if (resp.result != 0) {
            var title = "Backup storage " + config.storageEnv + " is unreacheable",
                text = "Backup storage environment " + config.storageEnv + " is not accessible for storing backups from " + config.envName + ". The error message is " + resp.error;
            try {
                jelastic.message.email.Send(appid, signature, null, user.email, user.email, title, text);
            } catch (ex) {
                emailResp = error(Response.ERROR_UNKNOWN, toJSON(ex));
            }
        }
        return resp;
    }

    me.removeMounts = function removeMountForBackup() {
        var allMounts = jelastic.env.file.GetMountPoints(config.envName, session, config.backupExecNode).array;
        for (var i = 0, n = allMounts.length; i < n; i++) {
            if (allMounts[i].sourcePath == "/data/" + config.envName && allMounts[i].path == "/opt/backup" && allMounts[i].name == "AppBackupRestore" && allMounts[i].type == "INTERNAL") {
                return jelastic.env.file.RemoveMountPointByGroup(config.envName, session, "cp", "/opt/backup");
            }
        }
        return {
            "result": 0
        };
    }

    me.checkEnvStatus = function checkEnvStatus() {
        if (!nodeManager.isEnvRunning()) {
            return {
                result : EnvironmentResponse.ENVIRONMENT_NOT_RUNNING,
                error : _("env [%(name)] not running", {name : config.envName})
            };
        }

        return { result : 0 };
    };

    me.checkStorageEnvStatus = function checkStorageEnvStatus() {
        if(typeof config.storageEnv !== 'undefined'){
            var resp = jelastic.env.control.GetEnvInfo(config.storageEnv, session);
            if (resp.result === 11){
                return {
                    result : EnvironmentResponse.ENVIRONMENT_NOT_EXIST,
                    error : _("Storage env [%(name)] is deleted", {name : config.storageEnv})
                };
            } else if (resp.env.status === 2) {
                return {
                    result : EnvironmentResponse.ENVIRONMENT_NOT_RUNNING,
                    error : _("Storage env [%(name)] not running", {name : config.storageEnv})
                };
            }
            return { result : 0 };
        };
        return { result : 0 };
    };

    me.createScript = function createScript() {
        var url = me.getScriptUrl("backup-main.js"),
            scriptName = config.scriptName,
            scriptBody,
            resp;

        try {
            scriptBody = new Transport().get(url);

            scriptBody = me.replaceText(scriptBody, config);

            //delete the script if it already exists
            jelastic.dev.scripting.DeleteScript(scriptName);

            //create a new script
            resp = jelastic.dev.scripting.CreateScript(scriptName, "js", scriptBody);

            java.lang.Thread.sleep(1000);

            //build script to avoid caching
            jelastic.dev.scripting.Build(scriptName);
        } catch (ex) {
            resp = { result : Response.ERROR_UNKNOWN, error: toJSON(ex) };
        }

        return resp;
    };


    me.scheduleBackup = function scheduleBackup() {
        var quartz = new CronToQuartzConverter().convert(config.cronTime);

        for (var i = quartz.length; i--;) {
            var resp = jelastic.utils.scheduler.CreateEnvTask({
                appid: appid,
                envName: config.envName,
                session: session,
                script: config.scriptName,
                trigger: "cron:" + quartz[i],
                params: { task: 1, action : "backup" }
            });

            if (resp.result !== 0) return resp;
        }

        return { result: 0 };
    };

    me.clearScheduledBackups = function clearScheduledBackups() {
        var envAppid = config.envAppid,
            resp = jelastic.utils.scheduler.GetTasks(envAppid, session);

        if (resp.result != 0) return resp;

        var tasks = resp.objects;

        for (var i = tasks.length; i--;) {
            if (tasks[i].script == config.scriptName) {
                resp = jelastic.utils.scheduler.RemoveTask(envAppid, session, tasks[i].id);

                if (resp.result != 0) return resp;
            }
        }

        return resp;
    };

    me.getFileUrl = function (filePath) {
        return config.baseUrl + "/" + filePath + "?_r=" + Math.random();
    };

    me.getScriptUrl = function (scriptName) {
        return me.getFileUrl("scripts/" + scriptName);
    };

    me.cmd = function cmd(commands, values, sep) {
        return nodeManager.cmd(commands, values, sep, true);
    };

    me.replaceText = function (text, values) {
        return new StrSubstitutor(values, "${", "}").replace(text);
    };

    me.exec = function (methods, oScope, bBreakOnError) {
        var scope,
            resp,
            fn;

        if (!methods.push) {
            methods = [ Array.prototype.slice.call(arguments) ];
            onFail = null;
            bBreakOnError = true;
        }

        for (var i = 0, n = methods.length; i < n; i++) {
            if (!methods[i].push) {
                methods[i] = [ methods[i] ];
            }

            fn = methods[i][0];
            methods[i].shift();

            log(fn.name + (methods[i].length > 0 ?  ": " + methods[i] : ""));
            scope = oScope || (methods[methods.length - 1] || {}).scope || this;
            resp = fn.apply(scope, methods[i]);

            log(fn.name + ".response: " + resp);

            if (resp.result != 0) {
                resp.method = fn.name;
                resp.type = "error";

                if (resp.error) {
                    resp.message = resp.error;
                }

                if (bBreakOnError !== false) break;
            }
        }

        return resp;
    };

    function NodeManager(envName, storageEnv, nodeId, baseDir, logPath) {
        var ENV_STATUS_TYPE_RUNNING = 1,
            me = this,
            storageEnvInfo,
            envInfo;

        me.isEnvRunning = function () {
            var resp = me.getEnvInfo();

            if (resp.result != 0) {
                throw new Error("can't get environment info: " + toJSON(resp));
            }

            return resp.env.status == ENV_STATUS_TYPE_RUNNING;
        };

        me.getEnvInfo = function () {
            var resp;

            if (!envInfo) {
                resp = jelastic.env.control.GetEnvInfo(envName, session);
                if (resp.result != 0) return resp;

                envInfo = resp;
            }

            return envInfo;
        };

        me.getStorageEnvInfo = function () {
            var resp;
            if (!storageEnvInfo) {
                resp = jelastic.env.control.GetEnvInfo(config.storageEnv, session);
                storageEnvInfo = resp;
            }
            return storageEnvInfo;
        };

        me.cmd = function (cmd, values, sep, disableLogging) {
            var resp,
                command;

            values = values || {};
            values.log = values.log || logPath;
            cmd = cmd.join ? cmd.join(sep || " && ") : cmd;

            command = _(cmd, values);

            if (!disableLogging) {
                log("cmd: " + command);
            }

            if (values.nodeGroup) {
                resp = jelastic.env.control.ExecCmdByGroup(envName, session, values.nodeGroup, toJSON([{ command: command }]), true, false, "root");
            } else {
                resp = jelastic.env.control.ExecCmdById(envName, session, values.nodeId, toJSON([{ command: command }]), true, "root");
            }

        if (resp.result != 0) {
        var title = "Backup failed for " + config.envName,
                text = "Backup failed for the environment " + config.envName + " of " + user.email + " with error message " + resp.responses[0].errOut;
        try {
                    jelastic.message.email.Send(appid, signature, null, user.email, user.email, title, text);
        } catch (ex) {
            emailResp = error(Response.ERROR_UNKNOWN, toJSON(ex));
        }
        }
            return resp;
        };
    }


    function CronToQuartzConverter() {
        this.getQuartz = function (cron) {
            var data = [];
            var quartzEntry;

            // check for cron magic entries
            quartzEntry = parseCronMagics(cron);

            if (quartzEntry) {
                data.push(quartzEntry);
            } else {

                // if cron magic entries not found, proceed to parsing normal cron format
                var crontabEntry = cron.split(' ');
                quartzEntry = parseCronSyntax(crontabEntry);

                data.push(quartzEntry);

                if (crontabEntry[2] !== '*' && crontabEntry[4] !== '*') {

                    crontabEntry[2] = '*';

                    quartzEntry = parseCronSyntax(crontabEntry);
                    data.push(quartzEntry);
                }

            }

            return data;
        };

        this.convert = function (cron) {
            var arr = this.getQuartz(cron);

            for (var i = 0, l = arr.length; i < l; i++) {
                arr[i] = arr[i].join(' ');
            }

            return arr;
        };

        function advanceNumber(str) {

            var quartzCompatibleStr = '';
            var num;
            str.split('').forEach(function (chr) {

                num = parseInt(chr);

                // char is an actual number
                if (!isNaN(num)) {
                    // number is in allowed range
                    if (num >= 0 && num <= 7) {
                        quartzCompatibleStr += num + 1;
                    } else {
                        // otherwise default to 1, beginning of the week
                        quartzCompatibleStr = 1;
                    }
                } else {
                    quartzCompatibleStr += chr;
                }



            });

            return quartzCompatibleStr;
        }

        function parseCronSyntax(crontabEntry) {

            var quartzEntry = [];

            // first we initialize the seconds to 0 by default because linux CRON entries do not include a seconds definition
            quartzEntry.push('0');

            // quartz scheduler can't handle an OR definition, and so it doesn't support both DOM and DOW fields to be defined
            // for this reason we need to shift one of them to be the value or * and the other to be ?
            var toggleQuartzCompat = false;

            crontabEntry.forEach(function (item, index, array) {


                // index 0 = minutes
                // index 1 = hours
                // these cron definitions should be compatible with quartz so we push them as is
                if (index === 0 || index === 1) {
                    quartzEntry.push(item);
                }

                // index 2 = DOM = Day of Month
                if (index === 2) {
                    if (item !== '?') {
                        toggleQuartzCompat = true;
                    }

                    if (item === '*') {
                        toggleQuartzCompat = false;
                        item = '?';
                    }

                    quartzEntry.push(item);
                }

                // index 3 = Month
                if (index === 3) {
                    quartzEntry.push(item);
                }

                // index 4 = DOW = Day of Week
                if (index === 4) {

                    // day of week needs another adjustments - it is specified as 1-7 in quartz but 0-6 in crontab
                    var itemAbbreviated = advanceNumber(item);

                    if (toggleQuartzCompat === true) {
                        quartzEntry.push('?');
                    } else {
                        quartzEntry.push(itemAbbreviated);
                    }
                }

                if (index >= 5) {
                    return true;
                }

            });

            quartzEntry.push('*');

            return quartzEntry;

        }

        function parseCronMagics(crontab) {

            var quartzEntry = false;

            // @hourly
            if (crontab.indexOf('@hourly') === 0) {
                quartzEntry = ['0', '0', '*', '*', '*', '?', '*'];
            }

            // @daily and @midnight
            if (crontab.indexOf('@daily') === 0 || crontab.indexOf('@midnight') === 0) {
                quartzEntry = ['0', '0', '0', '*', '*', '?', '*'];
            }

            // @weekly
            if (crontab.indexOf('@weekly') === 0) {
                quartzEntry = ['0', '0', '0', '?', '*', '1', '*'];
            }

            // @monthly
            if (crontab.indexOf('@monthly') === 0) {
                quartzEntry = ['0', '0', '0', '1', '*', '?', '*'];
            }

            // @yearly and @annually
            if (crontab.indexOf('@yearly') === 0 || crontab.indexOf('@annually') === 0) {
                quartzEntry = ['0', '0', '0', '1', '1', '?', '*'];
            }

            return quartzEntry || false;
        }
    }

    function log(message) {
        Logger.debug(message);
        return jelastic.marketplace.console.WriteLog(appid, session, message);
    }

    function _(str, values) {
        return new StrSubstitutor(values || {}, "%(", ")").replace(str);
    }
}
