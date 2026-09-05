"""BookWalker page image filename generator (b8g port) — validated against live HAR tokens."""
MASK32 = 0xFFFFFFFF


def v_jdf(filename):
    """'0' -> '10' (hex-length-prefixed), else '0'+filename"""
    try:
        v_ldf = int(filename, 10)
    except ValueError:
        v_ldf = -1
    if 0 <= v_ldf <= 1152921504606847000:
        v_mdf = hex(v_ldf)[2:]
        return hex(len(v_mdf))[2] + v_mdf
    return '0' + filename


def v_hdf(key1, key2, key3):
    """XOR three 32-byte keys into a 32-byte keystream b9W (bookworm: target[index] ^= key[index])"""
    b9w = [0] * 32
    for i in range(32):
        b9w[i] = (key1[i] if i < len(key1) else 0) ^ (key2[i] if i < len(key2) else 0) ^ (key3[i] if i < len(key3) else 0)
    return b9w


def v_ndf(p1_b9w, pageId, fileName='0'):
    """16-hex token via 3-register LCG (x435)."""
    parentFolder = pageId + '/'
    pathLength = len(parentFolder) + len(fileName)
    v_bef = (1 + pathLength) << 1

    v_cef = [0] * v_bef
    v_cef[0] = 0
    v_cef[1] = 59
    p = 2
    for ch in (parentFolder + fileName):
        code = ord(ch)
        v_cef[p] = code >> 8
        p += 1
        v_cef[p] = code % 256
        p += 1

    v_fef = 3
    v_eef = (len(fileName) << 1) + v_bef + v_bef
    while v_eef < 256:
        v_eef += v_bef
        v_fef += 1

    v_jef = 1670739
    v_kef = 1282576
    v_lef = 2237221

    i = (1 + len(parentFolder)) << 1
    j = 0
    for k in range(v_fef):
        while i < v_bef:
            v_lef ^= v_cef[i] ^ p1_b9w[j]
            i += 1
            v_ief = 435 * v_lef
            v_hef = 435 * v_kef + ((v_lef & 7) << 18) + (v_ief >> 22)
            v_gef = 435 * v_jef + ((v_kef & 3) << 19) + ((v_lef & 4194296) >> 3) + (v_hef >> 21)
            v_lef = v_ief & 4194303
            v_kef = v_hef & 2097151
            v_jef = v_gef & 2097151
            j += 1
            if j >= len(p1_b9w):
                j = 0
        i = 0

    def pval(index, value):
        def vval(v):
            return (48 if v < 10 else 87) + v
        out[index] = vval(value >> 4)
        out[index + 1] = vval(value & 15)

    out = [0] * 16
    b9w = p1_b9w
    pval(0, (v_jef >> 13) ^ b9w[0])
    pval(2, ((v_jef >> 5) & 255) ^ b9w[1])
    pval(4, (((v_jef & 31) << 3) | (v_kef >> 18)) ^ b9w[2])
    pval(6, ((v_kef >> 10) & 255) ^ b9w[3])
    pval(8, ((v_kef >> 2) & 255) ^ b9w[4])
    pval(10, (((v_kef & 3) << 6) | (v_lef >> 16)) ^ b9w[5])
    pval(12, ((v_lef >> 8) & 255) ^ b9w[6])
    pval(14, (v_lef & 255) ^ b9w[7])

    return ''.join(chr(c) for c in out)


def b8g(pageId, key1, key2, key3):
    """Returns the relative image URL: <pageId>/<hexlen><hexname><16-hex>.jpeg"""
    b9w = v_hdf(key1, key2, key3)
    return pageId + '/' + v_jdf('0') + v_ndf(b9w, pageId, '0') + '.jpeg'


if __name__ == '__main__':
    import sys, json
    sys.path.insert(0, '.')
    from bw_crypto import decode_config

    raw = open('live/configuration_pack.json', encoding='utf-8').read()
    parsed, k1, k2, k3 = decode_config(raw)

    # Ground truth from HAR: pageId -> 16-hex token (first 16 chars of jpeg name)
    import re
    har = json.load(open('../viewer.bookwalker.jp_sensitive.har'))
    truth = {}
    for e in har['log']['entries']:
        u = e['request']['url']
        m = re.search(r'/(p-[^/]+?)\.xhtml(?:\.region)?/([0-9a-f]{18})\.(?:jpeg|json)', u)
        if m:
            truth[m.group(1)] = m.group(2)
    print('ground-truth tokens from HAR:', len(truth))
    ok = 0
    for pageid, expected in sorted(truth.items()):
        got = b8g('OEBPS/text/' + pageid + '.xhtml', k1, k2, k3)
        token = got.split('/')[-1].replace('.jpeg', '')
        match = token == expected
        if match:
            ok += 1
        print(f'{pageid:20s} expected={expected}  got={token}  {"OK" if match else "MISMATCH"}')
    print(f'\n{ok}/{len(truth)} tokens match')
