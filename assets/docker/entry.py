#!/usr/bin/python3
"""Trusted PID1 child; Docker init reaps. Optional bounded loopback/UDS relay."""
import asyncio
import os
import signal


async def main():
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, stop.set)
    loop.add_signal_handler(signal.SIGINT, stop.set)
    active = 0

    async def relay(reader, writer):
        nonlocal active
        if active >= 32:
            writer.close()
            return
        active += 1
        upstream = None
        async def copy(src, dst):
            while True:
                chunk = await asyncio.wait_for(src.read(65536), 30)
                if not chunk:
                    return
                dst.write(chunk)
                await dst.drain()
        try:
            remote, upstream = await asyncio.open_unix_connection('/run/pi-chat-proxy/proxy.sock')
            tasks = [asyncio.create_task(copy(reader, upstream)), asyncio.create_task(copy(remote, writer))]
            try:
                await asyncio.wait(tasks, timeout=120, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except (OSError, asyncio.TimeoutError):
            pass
        finally:
            if upstream:
                upstream.close()
            writer.close()
            active -= 1

    server = None
    if os.path.exists('/run/pi-chat-proxy/proxy.sock'):
        # Fail startup if the selected OCI runtime cannot open host UDS.
        probe, connection = await asyncio.open_unix_connection('/run/pi-chat-proxy/proxy.sock')
        connection.close()
        server = await asyncio.start_server(relay, '127.0.0.1', 18080)
    await stop.wait()
    if server:
        server.close()
        await server.wait_closed()


asyncio.run(main())
