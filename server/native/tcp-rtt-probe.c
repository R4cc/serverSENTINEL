#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <linux/inet_diag.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <linux/sock_diag.h>
#include <linux/tcp.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef TCP_ESTABLISHED
#define TCP_ESTABLISHED 1
#endif

#define MAX_CONNECTIONS 2048

struct diag_request {
  struct nlmsghdr header;
  struct inet_diag_req_v2 request;
};

static int query_family(int fd, int family, uint16_t local_port, int emit,
                        uint16_t expected_remote_port, int *first, int *emitted) {
  static uint32_t sequence = 0;
  struct diag_request message;
  memset(&message, 0, sizeof(message));
  message.header.nlmsg_len = sizeof(message);
  message.header.nlmsg_type = SOCK_DIAG_BY_FAMILY;
  message.header.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
  message.header.nlmsg_seq = ++sequence;
  message.request.sdiag_family = (uint8_t)family;
  message.request.sdiag_protocol = IPPROTO_TCP;
  message.request.idiag_ext = (uint8_t)(1U << (INET_DIAG_INFO - 1));
  message.request.idiag_states = 1U << TCP_ESTABLISHED;
  message.request.id.idiag_sport = htons(local_port);
  message.request.id.idiag_cookie[0] = INET_DIAG_NOCOOKIE;
  message.request.id.idiag_cookie[1] = INET_DIAG_NOCOOKIE;

  if (send(fd, &message, sizeof(message), 0) < 0) return -1;
  int matches = 0;
  for (;;) {
    unsigned char buffer[64 * 1024];
    ssize_t received = recv(fd, buffer, sizeof(buffer), 0);
    if (received < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (received == 0) return -1;

    for (struct nlmsghdr *header = (struct nlmsghdr *)buffer;
         NLMSG_OK(header, (unsigned int)received);
         header = NLMSG_NEXT(header, received)) {
      if (header->nlmsg_seq != sequence) continue;
      if (header->nlmsg_type == NLMSG_DONE) return matches;
      if (header->nlmsg_type == NLMSG_ERROR) {
        const struct nlmsgerr *error = (const struct nlmsgerr *)NLMSG_DATA(header);
        return error->error == 0 ? matches : -1;
      }
      if (header->nlmsg_type != SOCK_DIAG_BY_FAMILY
          || header->nlmsg_len < NLMSG_LENGTH(sizeof(struct inet_diag_msg))) continue;

      const struct inet_diag_msg *diag = (const struct inet_diag_msg *)NLMSG_DATA(header);
      if (diag->id.idiag_sport != htons(local_port)) continue;
      uint32_t rtt_us = 0;
      int attributes_length = (int)header->nlmsg_len - (int)NLMSG_LENGTH(sizeof(*diag));
      for (struct rtattr *attribute = (struct rtattr *)(diag + 1);
           RTA_OK(attribute, attributes_length);
           attribute = RTA_NEXT(attribute, attributes_length)) {
        if (attribute->rta_type != INET_DIAG_INFO || RTA_PAYLOAD(attribute) < sizeof(struct tcp_info)) continue;
        const struct tcp_info *info = (const struct tcp_info *)RTA_DATA(attribute);
        rtt_us = info->tcpi_rtt;
      }
      if (rtt_us == 0) continue;

      const uint16_t remote_port = ntohs(diag->id.idiag_dport);
      if (expected_remote_port != 0 && remote_port != expected_remote_port) continue;
      if (*emitted >= MAX_CONNECTIONS) continue;
      char address[INET6_ADDRSTRLEN];
      const void *source = (const void *)&diag->id.idiag_dst[0];
      if (!inet_ntop(family, source, address, sizeof(address))) continue;
      matches += 1;
      *emitted += 1;
      if (emit) {
        if (!*first) putchar(',');
        *first = 0;
        printf("{\"remoteAddress\":\"%s\",\"remotePort\":%u,\"rttUs\":%u}",
               address, (unsigned int)remote_port, (unsigned int)rtt_us);
      }
    }
  }
}

static int collect(uint16_t port, int emit, uint16_t expected_remote_port) {
  int fd = socket(AF_NETLINK, SOCK_DGRAM | SOCK_CLOEXEC, NETLINK_SOCK_DIAG);
  if (fd < 0) return -1;
  struct sockaddr_nl address;
  memset(&address, 0, sizeof(address));
  address.nl_family = AF_NETLINK;
  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
    close(fd);
    return -1;
  }
  int first = 1;
  int emitted = 0;
  if (emit) fputs("{\"connections\":[", stdout);
  int ipv4 = query_family(fd, AF_INET, port, emit, expected_remote_port, &first, &emitted);
  int ipv6 = query_family(fd, AF_INET6, port, emit, expected_remote_port, &first, &emitted);
  if (emit) fputs("]}\n", stdout);
  close(fd);
  return ipv4 < 0 && ipv6 < 0 ? -1 : (ipv4 < 0 ? 0 : ipv4) + (ipv6 < 0 ? 0 : ipv6);
}

static int self_test(void) {
  int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  int client = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listener < 0 || client < 0) return 1;
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = 0;
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) < 0 || listen(listener, 1) < 0) return 1;
  socklen_t length = sizeof(address);
  if (getsockname(listener, (struct sockaddr *)&address, &length) < 0) return 1;
  if (connect(client, (struct sockaddr *)&address, sizeof(address)) < 0) return 1;
  int accepted = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
  if (accepted < 0) return 1;
  struct sockaddr_in client_address;
  length = sizeof(client_address);
  if (getsockname(client, (struct sockaddr *)&client_address, &length) < 0) return 1;
  const int matches = collect(ntohs(address.sin_port), 0, ntohs(client_address.sin_port));
  close(accepted);
  close(client);
  close(listener);
  return matches > 0 ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return self_test();
  if (argc != 3 || strcmp(argv[1], "--port") != 0) return 64;
  char *end = NULL;
  long port = strtol(argv[2], &end, 10);
  if (!end || *end != '\0' || port < 1 || port > 65535) return 64;
  return collect((uint16_t)port, 1, 0) < 0 ? 1 : 0;
}
