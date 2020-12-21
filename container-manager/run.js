const path = require("path");
const {getTag, getStorageRoot, isValidLanguage} = require("../helpers");
const Docker = require("dockerode");
const docker = Docker();
const uuid = require("uuid").v4;
const sanitize = require("sanitize-filename");
const {getMaxCPUs} = require("./resource-allocator");
const {cloneCode, saveChanges} = require("./storage-ops");

function execCode(projectId, language, schoolId, io) {
    io.to(projectId).emit('run', {
        status: 200,
        message: 'Starting...'
    });
    docker.createContainer({
        Image: getTag(language),
        name: projectId,
        WorkingDir: '/opt/runner',
        Binds: [
            path.resolve(getStorageRoot(), sanitize(projectId)) + ':/usr/src/app:rw',
        ],
        Entrypoint: [
            // Maximum run time for Python script (ensures infinite loops aren't left running)
            // written in minutes as a string
            // see https://linux.die.net/man/1/timeout
            `./run.sh`, parseInt(process.env.PAL_TIMEOUT || 15).toString() + "m",
        ],
        OpenStdin: true,
        Tty: true,
        // Maximum concurrent process IDs (PIDs) allowed within container
        // essential to preventing forkbomb/DDoS attacks
        // https://github.com/aaronryank/fork-bomb/blob/master/fork-bomb.py
        PidsLimit: parseInt(process.env.PAL_PID_LIMIT || 25),
        // Maximum RAM consumption of container in bytes
        // written as megabytes * 1048576
        Memory: parseInt(process.env.PAL_MEMORY_QUOTA || 100 * 1048576),
        // Maximum disk size of container in bytes
        // written as megabytes * 1048576
        DiskQuota: parseInt(process.env.PAL_DISK_QUOTA || 50 * 1048576),
        NanoCPUs: getMaxCPUs(),
    }, (err, container) => {
        if (err) {
            console.log(err);
            io.to(projectId).emit('run', {
                status: 500,
                message: 'Run failed. Try again.',
                running: false,
            });
            return;
        }

        io.to(projectId).emit('run', {
            status: 200,
            message: 'Container created! Mounting...',
            running: true,
        });

        container.start();
        container.attach({
            stream: true,
            stdout: true,
            stderr: true,
        }, (err, stream) => {
            stream.on('data', (chunk) => {
                const stdout = chunk.toString('utf8');
                const stdoutID = uuid();
                io.to(projectId).emit('run', {
                    status: 200,
                    stdout,
                    stdoutID,
                    running: true,
                });
            });

            stream.on('end', async () => {
                io.to(projectId).emit('run', {
                    status: 200,
                    running: false,
                });
                // ensure we fully delete the container once it has stopped
                await containerStop(projectId);
                await saveChanges(projectId, schoolId);
            });
        });
    });
}

async function containerStdin(projectId, stdin) {
    const container = docker.getContainer(projectId);
    container.attach({
        stream: true,
        stdin: true,
        hijack: true,
    }, (err, stream) => {
        if (stream) {
            stream.write(stdin, () => {
                stream.end();
            });
        }
        return container.wait();
    });
}

async function containerStop(projectId) {
    let container;
    // run kill and remove separately; kill may fail if the container isn't already running
    try {
        container = docker.getContainer(projectId);
        await container.kill({
            signal: process.env.PAL_STOP_SIGNAL || 'SIGKILL',
        });
    } catch (e) {}

    try {
        await container.remove({
            force: true,
        });
    } catch (e) {}
}

module.exports = (io) => {
    io.on('connection', (socket) => {
        socket.on('start', async (data) => {
            if (!data.projectId || !isValidLanguage(data.language) || !data.schoolId) {
                socket.emit('run', {
                    status: 400,
                });
                return;
            }

            socket.emit('run', {
                status: 200,
                message: 'Request acknowledged. Downloading code...',
            });

            // clone latest code
            try {
                await cloneCode(data.projectId, data.schoolId);
            } catch (e) {
                socket.emit('run', {
                    status: 404,
                });
                return;
            }

            await containerStop(data.projectId);

            // ensure we aren't broadcasting any other projects
            // this function is undocumented (?) but does exist: https://github.com/socketio/socket.io/blob/1decae341c80c0417b32d3124ca30c005240b48a/lib/socket.js#L287
            socket.leaveAll();

            socket.join(data.projectId);
            execCode(data.projectId, data.language, data.schoolId, io);
        });

        socket.on('stdin', async (data) => {
            if (!data.projectId || !data.stdin) {
                socket.emit('run', {
                    status: 400,
                });
                return;
            }

            await containerStdin(data.projectId, data.stdin);
        });

        socket.on('stop', async (data) => {
            if (!data.projectId) {
                socket.emit('run', {
                    status: 400,
                });
                return;
            }

            await containerStop(data.projectId);
            // keep the browser updated quickly if the server can't handle tons of requests
            socket.emit('run', {
                status: 200,
                running: false,
            });
        });
    });
}
