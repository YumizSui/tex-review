#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { createHash } from 'node:crypto';
// Run from the workspace root. Requests and results use JSON; no shell interpolation is needed.
const [operation, argument] = process.argv.slice(2);
try {
    const descriptor = JSON.parse(fs.readFileSync(path.resolve('.review/api.json'), 'utf8'));
    let request;
    if (operation === 'read' && argument)
        request = { op: 'read', file: argument };
    else if (operation === 'transact')
        request = { op: 'transact', transaction: JSON.parse(fs.readFileSync(argument || 0, 'utf8')) };
    else if (operation === 'recover')
        request = { op: 'recover' };
    else
        throw new Error('Usage: node tex-review.mjs read <source.tex> | transact [request.json] | recover');
    const response = await new Promise((resolve, reject) => {
        const socket = net.createConnection(descriptor.endpoint);
        socket.setEncoding('utf8');
        let buffer = '';
        socket.setTimeout(30000, () => socket.destroy(new Error('API timed out. Retry the same transaction ID to learn its result; do not create a new ID.')));
        socket.on('connect', () => socket.write(JSON.stringify({ session: descriptor.session, ...request }) + '\n'));
        socket.on('data', data => { buffer += data; const end = buffer.indexOf('\n'); if (end >= 0) {
            try {
                resolve(JSON.parse(buffer.slice(0, end)));
            }
            catch (error) {
                reject(error);
            }
            socket.destroy();
        } });
        socket.on('error', reject);
        socket.on('end', () => { if (!buffer.includes('\n'))
            reject(new Error('API disconnected before reporting a result.')); });
    });
    if (request.op === 'read' && response.ok) {
        const text = response.result?.text, revision = response.result?.revision;
        if (typeof text !== 'string' || typeof revision !== 'string' || createHash('sha256').update(text).digest('hex') !== revision)
            throw new Error('Source response failed its revision integrity check. Read the source again.');
    }
    process.stdout.write(JSON.stringify(response, null, 2) + '\n');
    if (!response.ok)
        process.exitCode = 1;
}
catch (error) {
    process.stderr.write(String(error.message || error) + '\n');
    process.exitCode = 1;
}
