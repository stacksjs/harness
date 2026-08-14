/*
 * The PTY syscalls Bun cannot make from JavaScript, compiled at runtime by
 * bun:ffi's bundled TinyCC — no build step, no native dependency to install.
 *
 * Everything platform-variable (ioctl request numbers, spawn flags) is passed
 * in from TypeScript rather than #ifdef'd here, because TinyCC's bundled
 * headers are stubs: relying on them is how the first draft of this file got
 * ENOTTY from a "TIOCSWINSZ" that wasn't. Prototypes are declared by hand for
 * the same reason — TinyCC treats implicit declarations as errors.
 *
 * Two facts this file encodes that cost real debugging to learn:
 * - Variadic libc functions (ioctl, fcntl, open) CANNOT be called through
 *   bun:ffi's dlopen on Apple arm64 — variadic args go on the stack there,
 *   fixed-signature FFI puts them in registers. C callers compile correctly.
 * - On macOS/BSD the winsize ioctls live on the *slave* side of the pty;
 *   TIOCSWINSZ against the master returns ENOTTY. The server keeps a slave
 *   fd open purely so resize() has somewhere to aim.
 */

extern int posix_openpt(int flags);
extern int grantpt(int fd);
extern int unlockpt(int fd);
extern char *ptsname(int fd);
extern int open(const char *path, int flags, ...);
extern int close(int fd);
extern int ioctl(int fd, unsigned long request, ...);
extern int fcntl(int fd, int cmd, ...);
extern int waitpid(int pid, int *status, int options);
extern char **environ;

extern int fork(void);
extern int login_tty(int fd);
extern int chdir(const char *path);
extern int execve(const char *path, char *const argv[], char *const envp[]);
extern void _exit(int code);

#define O_RDWR_L 0x0002
#define F_SETFL_L 4
#define WNOHANG_L 1

int harness_open_pty_master(void) {
  int fd = posix_openpt(O_RDWR_L);
  if (fd < 0) return -1;
  if (grantpt(fd) != 0 || unlockpt(fd) != 0) { close(fd); return -1; }
  return fd;
}

int harness_open_pty_slave(int master) {
  char *path = ptsname(master);
  if (!path) return -1;
  return open(path, O_RDWR_L);
}

int harness_set_winsize(int fd, int cols, int rows, unsigned long request) {
  struct { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; } ws;
  ws.ws_row = (unsigned short)rows;
  ws.ws_col = (unsigned short)cols;
  ws.ws_xpixel = 0;
  ws.ws_ypixel = 0;
  return ioctl(fd, request, &ws);
}

int harness_set_nonblocking(int fd, int nonblock_flag) {
  return fcntl(fd, F_SETFL_L, nonblock_flag);
}

/*
 * Spawn `shell` on the pty's slave as its controlling terminal — the classic
 * forkpty shape: fork, then in the child login_tty(slave), which does
 * setsid + TIOCSCTTY + the dup2s onto 0/1/2, then execve. The child never
 * returns into the runtime: it either execs or _exits, and everything it
 * calls between fork and exec is async-signal-safe. posix_spawn with a
 * SETSID attribute was tried first and left tpgid at 0 on both platforms —
 * the file-action open does not acquire a controlling terminal, so the shell
 * ran without job control and ^C had no foreground group to reach.
 *
 * The unused `setsid_flag` parameter is kept so the TS caller has one
 * signature across this shim and the Linux dlopen one.
 */
int harness_spawn_on_pty(int master, const char *shell, const char *cwd, char *const envp[], int setsid_flag) {
  (void)setsid_flag;
  char *slave_path = ptsname(master);
  if (!slave_path) return -1;
  int slave = open(slave_path, O_RDWR_L);
  if (slave < 0) return -1;
  int pid = fork();
  if (pid == 0) {
    login_tty(slave);
    close(master);
    if (cwd && cwd[0]) chdir(cwd);
    char *argv[2];
    argv[0] = (char *)shell;
    argv[1] = 0;
    execve(shell, argv, envp && envp[0] ? envp : environ);
    _exit(127);
  }
  close(slave);
  return pid;
}

/*
 * Reap without blocking. Returns -1 while the child runs, the exit code once
 * it exited, or 128+signal if a signal took it — the shell convention, so a
 * SIGKILLed shell reports 137 rather than pretending it exited cleanly.
 */
int harness_poll_exit(int pid) {
  int status = 0;
  int rc = waitpid(pid, &status, WNOHANG_L);
  if (rc != pid) return -1;
  if ((status & 0x7F) == 0) return (status >> 8) & 0xFF;
  return 128 + (status & 0x7F);
}
