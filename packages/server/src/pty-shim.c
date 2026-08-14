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

typedef void *spawn_actions_t;
typedef void *spawn_attr_t;
extern int posix_spawn_file_actions_init(spawn_actions_t *fa);
extern int posix_spawn_file_actions_addopen(spawn_actions_t *fa, int fd, const char *path, int flags, int mode);
extern int posix_spawn_file_actions_adddup2(spawn_actions_t *fa, int from, int to);
extern int posix_spawn_file_actions_addclose(spawn_actions_t *fa, int fd);
extern int posix_spawn_file_actions_addchdir_np(spawn_actions_t *fa, const char *path);
extern int posix_spawn_file_actions_destroy(spawn_actions_t *fa);
extern int posix_spawnattr_init(spawn_attr_t *attr);
extern int posix_spawnattr_setflags(spawn_attr_t *attr, short flags);
extern int posix_spawnattr_destroy(spawn_attr_t *attr);
extern int posix_spawn(int *pid, const char *path, spawn_actions_t *fa, spawn_attr_t *attr, char *const argv[], char *const envp[]);

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
 * Spawn `shell` on the pty's slave as its controlling terminal. SETSID
 * detaches the child from our session, and the addopen of the slave is then
 * its first tty open — which is what acquires a controlling terminal, so the
 * shell gets real job control and ^C reaches the foreground group.
 */
int harness_spawn_on_pty(int master, const char *shell, const char *cwd, char *const envp[], int setsid_flag) {
  char *slave = ptsname(master);
  if (!slave) return -1;
  spawn_actions_t fa;
  spawn_attr_t attr;
  if (posix_spawn_file_actions_init(&fa) != 0) return -1;
  posix_spawn_file_actions_addopen(&fa, 0, slave, O_RDWR_L, 0);
  posix_spawn_file_actions_adddup2(&fa, 0, 1);
  posix_spawn_file_actions_adddup2(&fa, 0, 2);
  posix_spawn_file_actions_addclose(&fa, master);
  if (cwd && cwd[0]) posix_spawn_file_actions_addchdir_np(&fa, cwd);
  posix_spawnattr_init(&attr);
  posix_spawnattr_setflags(&attr, (short)setsid_flag);
  char *argv[2];
  argv[0] = (char *)shell;
  argv[1] = 0;
  int pid = -1;
  int rc = posix_spawn(&pid, shell, &fa, &attr, argv, envp && envp[0] ? envp : environ);
  posix_spawn_file_actions_destroy(&fa);
  posix_spawnattr_destroy(&attr);
  return rc == 0 ? pid : -1;
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
