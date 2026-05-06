const net = require('net');
const { exec } = require('child_process');

// Function to check if a port is available
function checkPort(port) {
    return new Promise((resolve) => {
        const server = net.createServer();

        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') resolve(false); // port in use
            else resolve(false); // other error
        });

        server.once('listening', () => {
            server.close();
            resolve(true); // port is free
        });

        server.listen(port, '127.0.0.1');
    });
}

// Function to find first available port automatically
async function findAvailablePort(start = 3000, max = 65535) {
    for (let port = start; port <= max; port++) {
        const isFree = await checkPort(port);
        if (isFree) return port;
    }
    return null; // no free port found
}

// Get all running ports with PID (Windows)
function getRunningPorts() {
    return new Promise((resolve) => {
        exec('netstat -ano', (err, stdout, stderr) => {
            if (err) return resolve({});
            const lines = stdout.split('\n').slice(4);
            const portsInUse = {};

            lines.forEach(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 5) {
                    const localAddress = parts[1];
                    const pid = parts[4];
                    const portMatch = localAddress.match(/:(\d+)$/);
                    if (portMatch) {
                        const port = parseInt(portMatch[1]);
                        portsInUse[port] = pid;
                    }
                }
            });

            resolve(portsInUse);
        });
    });
}

// Get program name from PID (Windows)
function getProgramName(pid) {
    return new Promise((resolve) => {
        exec(`tasklist /FI "PID eq ${pid}"`, (err, stdout, stderr) => {
            if (err) return resolve('-');
            const lines = stdout.split('\n');
            if (lines.length >= 4) {
                const program = lines[3].trim().split(/\s+/)[0];
                resolve(program);
            } else {
                resolve('-');
            }
        });
    });
}

// Main function
(async () => {
    const portsInUse = await getRunningPorts();
    console.log('Currently Running Ports:');
    console.log('Port\tPID\tProgram');
    console.log('-----------------------------');

    for (const port of Object.keys(portsInUse).sort((a, b) => a - b)) {
        const pid = portsInUse[port];
        const program = await getProgramName(pid);
        console.log(`${port}\t${pid}\t${program}`);
    }

    // Automatically find a free port
    const freePort = await findAvailablePort(3000, 65535);
    if (freePort) {
        console.log(`\n✅ Automatically assigned free port: ${freePort}`);
    } else {
        console.log('\n⚠ No available port found!');
    }
})();
