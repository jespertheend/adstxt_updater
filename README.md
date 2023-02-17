# ads.txt Updater

adstxt_updater is a single binary executable that keeps your ads.txt up to date.

## Features

- Downloads ads.txt from public servers and writes it as a file on your server.
  Meaning it works with any server software that can host files from disk.
- Can concatenate multiple ads.txt files from different URLs, in case you have ads from multiple vendors.
- Automatically overwrites the ads.txt when other software tries to change it.
  This allows you to completely overwrite your entire site when deploying a new version,
  without having to worry if the ads.txt is still there.

## Installation

1. Download and extract the [latest release](https://github.com/jespertheend/adstxt_updater/releases/latest) for your platform.
2. Create a config file (see an example below)
3. Run `./adstxt_updater /path/to/config.yml`

## Usage

### Basic configuration

A basic configuration file contains two things:
a destination path and a list of URLs where you want to copy the contents of your ads.txt from

```yml
destination: /var/www/html/ads.txt
sources:
  - https://example.com/ads.txt
  - https://example.com/ads2.txt
```

In this case, adstxt_updater will download the two ads.txt files from example.com,
concatenate them, and write the result to `/var/www/html/ads.txt`.

### Generating multiple ads.txt files

If you have multiple domains hosted on the same server, and you wish for multiple ads.txt files to be generated,
there are two ways to achieve this:

- Create multiple configuration files and pass them all as arguments.
  For instance, `./adstxt_updater /path/to/config1.yml /path/to/config2.yml`.
- Use a single configuration file and list multiple destinations with their sources there:

```yml
- destination: ./path/to/ads1.txt
  sources:
    - https://example.com/ads.txt
    - https://example.com/ads2.txt
- destination: ./path/to/ads2.txt
  sources:
    - https://example.com/ads.txt
    - https://example.com/ads2.txt
```

## Stripping variables

If one of the ads.txt files that you are downloading contains variables that you don't want to include in yours,
you can remove them using the `strip_variables` property.

```yml
destination: /var/www/html/ads.txt
sources:
  - https://example.com/ads.txt
  - source: https://example.com/ads2.txt
    transform:
      strip_variables: true
```

## Keeping adstxt_updater running in the background

The way you run applications in the background depends on what OS you are using.
Many Linux distributions come with systemd by default.
On Ubuntu, you can create a systemd service for adstxt_updater
by adding the following file to `/etc/systemd/system/adstxt_updater.service`:

```
[Unit]
Description=adstxt_updater
After=network.target

[Service]
ExecStart=/usr/bin/adstxt_updater /etc/adstxt_updater.yml
Type=simple
```

Make sure you have placed the adstxt_updater binary in `/usr/bin` (which is a common location for binaries),
and the configuration file at `/etc/adstxt_updater.yml` (which is a common location for configuration files).

You can then start the service with `service adstxt_updater start` and monitor its logs using `journalctl -fu adstxt_updater`.
