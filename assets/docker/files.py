#!/usr/bin/python3
"""Protocol 1. Linux dir-fd walk; reject every symlink and multiply-linked file.
The same trusted helper is used for host bridges and container tools. No shell.
"""
import os
import stat
import sys
import secrets

LIMIT = 50 * 1024 * 1024
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def walk(root, parts, create=False):
    fd = os.open('/', DIR)
    try:
        for part in root.split('/') + parts:
            if not part:
                continue
            if part in ('.', '..') or '\0' in part:
                raise ValueError('invalid path')
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            nxt = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def regular(fd):
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > LIMIT:
        raise ValueError('regular single-link bounded file required')
    return st


def main():
    op, root, relative = sys.argv[1:4]
    if not root.startswith('/') or relative.startswith('/'):
        raise ValueError('invalid root/path')
    parts = relative.split('/') if relative else []
    if any(p in ('', '.', '..') for p in parts):
        raise ValueError('invalid components')
    if op == 'mkdir':
        fd = walk(root, parts, True)
        os.close(fd)
        return
    if not parts:
        raise ValueError('file required')
    parent = walk(root, parts[:-1])
    name = parts[-1]
    try:
        if op in ('read', 'access', 'edit-access'):
            fd = os.open(name, (os.O_RDWR if op == 'edit-access' else os.O_RDONLY) | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                regular(fd)
                if op == 'read':
                    size = 0
                    while True:
                        block = os.read(fd, 65536)
                        if not block:
                            break
                        size += len(block)
                        if size > LIMIT:
                            raise ValueError('file limit')
                        sys.stdout.buffer.write(block)
            finally:
                os.close(fd)
        elif op in ('write', 'touch', 'secret'):
            mode = 0o600
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    mode = stat.S_IMODE(regular(fd).st_mode) & 0o777
                finally:
                    os.close(fd)
                if op == 'touch':
                    return
            except FileNotFoundError:
                pass
            if op == 'secret':
                mode = 0o600
                os.fchmod(parent, 0o700)
            temp = '.pi-chat-' + secrets.token_hex(16)
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                size = 0
                while True:
                    block = sys.stdin.buffer.read(65536)
                    if not block:
                        break
                    size += len(block)
                    if size > LIMIT:
                        raise ValueError('file limit')
                    view = memoryview(block)
                    while view:
                        view = view[os.write(fd, view):]
                os.fchmod(fd, mode)
                os.fsync(fd)
                os.rename(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
            finally:
                os.close(fd)
                try:
                    os.unlink(temp, dir_fd=parent)
                except FileNotFoundError:
                    pass
        else:
            raise ValueError('unknown operation')
    finally:
        os.close(parent)


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        sys.stderr.write('pi-chat file operation rejected\n')
        sys.exit(1)
