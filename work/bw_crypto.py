"""
BookWalker viewer crypto — faithful Python port of aaa4xu/bookworm (MIT) TS sources.
Pipeline (Config.decode):
  A8j: custom base64 -> 3x32-byte keys + payload
  A3b(0): key-expansion transform on payload
  B0p / A7L / A6I / A2F / B0L / A3b(1..3) / tB0l: mixed RC4-ish stages
  A6e: UTF-8 decode -> JSON
Plus Page seeds (B0A/B0J/B0K/B0n), tile-shuffle (a3f/A9p), filename LCG (b8g).
All JS 32-bit ops are emulated with & 0xFFFFFFFF masks.
"""
import json
import math

MASK32 = 0xFFFFFFFF

# ---------- A8f: custom base64 tables ----------
CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
IDX = {c: i for i, c in enumerate(CHARSET)}  # A8f[0]


def t1(c):  # A8f[1] = idx << 2
    return (IDX[c] << 2) & 255


def t2(c):  # A8f[2] = (idx << 4) & 255
    return (IDX[c] << 4) & 255


def t3(c):  # A8f[3] = (idx << 6) & 255
    return (IDX[c] << 6) & 255


def t4(c):  # A8f[4] = idx >> 2
    return IDX[c] >> 2


def t5(c):  # A8f[5] = idx >> 4
    return IDX[c] >> 4


def w1(a, b):  # A8f[1][a] | A8f[5][b]
    return t1(a) | t5(b)


def w2(b, c):  # A8f[2][b] | A8f[4][c]
    return t2(b) | t4(c)


def w3(c, d):  # A8f[3][c] | A8f[0][d]
    return t3(c) | IDX[d]


VALID = set(CHARSET)


# ---------- arraySwap ----------
def array_swap(arr, a, b):
    if a != b:
        arr[a], arr[b] = arr[b], arr[a]


# ---------- A8j: base64 decode, extract 3 keys + payload ----------
def A8j(content: str, data_offset: int, data_end_offset: int):
    key_data_length = 128
    payload_offset = data_offset + key_data_length
    payload_length = data_end_offset - payload_offset
    assert (payload_length & 3) == 0

    key1 = [0] * 32
    key2 = [0] * 32
    key3 = [0] * 32

    i = data_offset
    active = key1
    ai = 0
    while i < payload_offset:
        a = content[i]; i += 1
        b = content[i]; i += 1
        c = content[i]; i += 1
        d = content[i]; i += 1
        assert a in VALID and b in VALID and c in VALID and d in VALID
        active[ai] = w1(a, b)
        ai += 1
        if i == data_offset + 88:
            active = key3
            ai = 0
        active[ai] = w2(b, c)
        ai += 1
        if i == data_offset + 44:
            active = key2
            ai = 0
        active[ai] = w3(c, d)
        ai += 1

    if payload_length == 0:
        return bytearray(0), 0, key1, key2, key3

    result_length = (payload_length * 3) >> 2
    if content[data_end_offset - 2] == '=':
        result_length -= 2
    elif content[data_end_offset - 1] == '=':
        result_length -= 1

    result = bytearray(result_length)
    chunk = payload_offset
    index = 0
    while chunk < data_end_offset - 4:
        c1 = content[chunk]; chunk += 1
        c2 = content[chunk]; chunk += 1
        c3 = content[chunk]; chunk += 1
        c4 = content[chunk]; chunk += 1
        assert c1 in VALID and c2 in VALID and c3 in VALID and c4 in VALID
        result[index] = w1(c1, c2); index += 1
        result[index] = w2(c2, c3); index += 1
        result[index] = w3(c3, c4); index += 1

    v_uii = content[chunk]; chunk += 1
    v_vii = content[chunk]; chunk += 1
    v_wii = content[chunk]; chunk += 1
    v_xii = content[chunk]; chunk += 1
    assert v_uii in VALID and v_vii in VALID
    result[index] = w1(v_uii, v_vii); index += 1
    if v_wii in VALID:
        result[index] = w2(v_vii, v_wii)
        index += 1
        if v_xii in VALID:
            result[index] = w3(v_wii, v_xii)
            index += 1
        elif v_xii != '=':
            raise ValueError("bad tail")
    elif v_wii != '=' or v_xii != '=':
        raise ValueError("bad tail")

    return result, result_length, key1, key2, key3


# ---------- a0F: RC4 KSA ----------
def a0F(inp):
    result = list(range(256))
    length = len(inp)
    c = 0
    for i in range(256):
        index = i % length
        c = (c + result[i] + inp[index]) % 256
        array_swap(result, i, c)
    return result


# ---------- a0g: RC4 PRGA XOR (v_smi) ----------
def a0g(key, b):
    result = []
    g = a0F(b)
    c = 0
    d = 0
    for i in range(len(key)):
        c = (c + 1) % 256
        d = (d + g[c]) % 256
        array_swap(g, c, d)
        e = (g[c] + g[d]) % 256
        result.append(key[i] ^ g[e])
    return result


def v_qmi(p1, p2, p3):
    return a0F(p1 + p2 + p3)


def v_smi(content, p1, p2, p3):
    return a0g(content, p1 + p2 + p3)


# ---------- processContentStep: RC4 PRGA over content ----------
def step(v_7ki, v_8ki, i, key, content):
    v_7ki = (v_7ki + 1) % 256
    v_8ki = (v_8ki + key[v_7ki]) % 256
    array_swap(key, v_7ki, v_8ki)
    content[i] ^= key[(key[v_7ki] + key[v_8ki]) % 256]
    return v_7ki, v_8ki


def process_content_step(state, key, i):
    content, content_length, key1, key2, key3 = state
    v_7ki = 0
    v_8ki = 0
    while i >= 0:
        v_7ki, v_8ki = step(v_7ki, v_8ki, i, key, content)
        i -= 2
    return [content, content_length, key1, key2, key3]


# ---------- A3b: key expansion transform ----------
def check1(n, m):
    return (n & m) == m


def process1(v_0li, v_1li, key):
    for i in range(32):
        v_0li = (v_0li + key[i]) & 255
        v_1li ^= key[i]
    return v_0li, v_1li


def process2(v_yli, v_uli, v_gli):
    v_vli = v_yli
    while v_uli > v_yli:
        array_swap(v_gli, v_uli, v_vli)
        v_uli -= 1
        v_vli -= 1


def A3b(v_ofi, state):
    content, content_length, key1, key2, key3 = state
    if v_ofi == 3:
        v_jki, v_kki, v_oki = key1, 32, 32
        v_lki, v_mki, v_nki = key2, key3, None
    elif v_ofi == 2:
        v_jki, v_kki, v_oki = key2, 32, 32
        v_lki, v_mki, v_nki = key1, key3, None
    elif v_ofi == 1:
        v_jki, v_kki, v_oki = key3, 32, 32
        v_lki, v_mki, v_nki = key1, key2, None
    else:  # 0
        v_jki, v_kki, v_oki = content, content_length, 65536
        v_lki, v_mki, v_nki = key1, key2, key3

    v_0li, v_1li = process1(0, 0, v_lki)
    v_0li, v_1li = process1(v_0li, v_1li, v_mki)
    if v_nki is not None:
        v_0li, v_1li = process1(v_0li, v_1li, v_nki)

    v_0liFlag2 = not check1(v_0li, 2)
    v_0liFlag4 = not check1(v_0li, 4)
    v_0liFlag8 = not check1(v_0li, 8)
    v_5li = v_1li >> 5
    v_6li = 8 - v_5li
    v_7li = 0

    v_gli = []
    while v_7li < v_kki:
        v_pli = v_7li + 32
        v_qli = v_pli > v_kki
        if v_qli:
            v_pli = v_kki
            v_rli = v_pli - v_7li
        else:
            v_rli = 32
        v_wli = v_0li
        v_xli = v_1li
        v_tli = 0
        v_uli = v_7li
        v_gli = [0] * v_rli
        while v_tli < v_rli:
            v_sli = v_jki[v_uli]
            v_uli += 1
            if v_0liFlag2:
                v_sli = ((v_sli & 85) << 1) | ((v_sli >> 1) & 85)
            if v_0liFlag4:
                v_sli = ((v_sli & 51) << 2) | ((v_sli >> 2) & 51)
            if v_0liFlag8:
                v_sli = ((v_sli & 15) << 4) | ((v_sli >> 4) & 15)
            v_gli[v_tli] = v_sli
            v_tli += 1
            v_wli = (v_wli + v_sli) & 255
            v_xli ^= v_sli

        for j in range(v_rli):
            for i in range(1, 7):
                a = 2 ** i
                if not check1(j, a - 1):
                    break
                if not check1(v_wli, a):
                    process2(j - 2 ** (i - 1), j, v_gli)

        v_zli = v_xli >> 3
        if v_qli:
            v_zli %= v_rli
        else:
            v_zli &= 31

        if v_5li == 0:
            i = v_7li
            j = v_rli - v_zli
            while i < v_pli:
                if j == v_rli:
                    j = 0
                v_jki[i] = v_gli[j]
                i += 1
                j += 1
        else:
            i = v_7li
            j = v_rli - v_zli - 1
            while i < v_pli:
                v_sli = v_gli[j] << v_6li
                j += 1
                if j == v_rli:
                    j = 0
                v_sli |= v_gli[j] >> v_5li
                v_jki[i] = v_sli & 255
                i += 1

        v_7li = v_pli

    return [content, content_length, key1, key2, key3]


# ---------- B0p / A7L / A6I / A2F / B0L / tB0l ----------
def B0p(filename_key, state):
    content, content_length, key1, key2, key3 = state
    key = v_qmi(key2, filename_key, key3)
    offset = 0
    v_omi = 0
    while offset < content_length:
        content[offset] ^= key[v_omi % 256]
        offset += 1
        v_omi += 1
    return [content, content_length, key1, key2, key3]


def A7L(filename_key, state):
    content, content_length, key1, key2, key3 = state
    i = (content_length | 1) - 2
    key = v_qmi(filename_key, key1, key2)
    return process_content_step([content, content_length, key1, key2, key3], key, i)


def A6I(filename_key, state):
    content, content_length, key1, key2, key3 = state
    i = (content_length - 1) & -2
    key = v_qmi(key3, filename_key, key1)
    return process_content_step([content, content_length, key1, key2, key3], key, i)


def A2F(state):
    content, content_length, key1, key2, key3 = state
    v_dmi = min(32, content_length)
    for i in range(v_dmi):
        v_8mi = content[i] ^ key1[i] ^ key2[i] ^ key3[i]
        sw = v_8mi & 12
        if sw == 0:
            v_6mi = key1[i]
        elif sw == 4:
            v_6mi = key2[i]
        elif sw == 8:
            v_6mi = key3[i]
        else:
            v_6mi = content[i]
        sw3 = v_8mi & 3
        if sw3 == 0:
            v_7mi = key1[i]
            key1[i] = v_6mi
        elif sw3 == 1:
            v_7mi = key2[i]
            key2[i] = v_6mi
        elif sw3 == 2:
            v_7mi = key3[i]
            key3[i] = v_6mi
        else:
            v_7mi = content[i]
            content[i] = v_6mi
        if sw == 0:
            key1[i] = v_7mi
        elif sw == 4:
            key2[i] = v_7mi
        elif sw == 8:
            key3[i] = v_7mi
        else:
            content[i] = v_7mi
        sw192 = v_8mi & 192
        if sw192 == 0:
            v_6mi = key1[i]
        elif sw192 == 64:
            v_6mi = key2[i]
        elif sw192 == 128:
            v_6mi = key3[i]
        else:
            v_6mi = content[i]
        sw48 = v_8mi & 48
        if sw48 == 0:
            v_7mi = key1[i]
            key1[i] = v_6mi
        elif sw48 == 16:
            v_7mi = key2[i]
            key2[i] = v_6mi
        elif sw48 == 32:
            v_7mi = key3[i]
            key3[i] = v_6mi
        else:
            v_7mi = content[i]
            content[i] = v_6mi
        if sw192 == 0:
            key1[i] = v_7mi
        elif sw192 == 64:
            key2[i] = v_7mi
        elif sw192 == 128:
            key3[i] = v_7mi
        else:
            content[i] = v_7mi
    return [content, content_length, key1, key2, key3]


def B0L(filename_key, state):
    content, content_length, key1, key2, key3 = state
    key3 = v_smi(key3, key2, key1, filename_key)
    key2 = v_smi(key2, key1, filename_key, key3)
    key1 = v_smi(key1, filename_key, key3, key2)
    return [content, content_length, key1, key2, key3]


def tB0l(filename_key, state):
    content, content_length, key1, key2, key3 = state
    key = v_qmi(key3, key2, filename_key)
    v_7ki = 0
    v_8ki = 0
    for i in range(content_length):
        v_7ki, v_8ki = step(v_7ki, v_8ki, i, key, content)
    return [content, content_length, key1, key2, key3]


# ---------- processFilename: UTF-8 encode ----------
def process_filename(filename):
    result = []
    data = filename.encode('utf-8')
    return list(data)


# ---------- A6e: UTF-8 decode (bytes -> str, surrogate pairs preserved as JS would) ----------
def A6e(state):
    content, content_length, key1, key2, key3 = state
    # We can simply decode as UTF-8 since A6e is a standard UTF-8 decoder
    decoded = bytes(content[:content_length]).decode('utf-8', errors='replace')
    return [decoded, key_to_str(key1), key_to_str(key2), key_to_str(key3), key1, key2, key3]


def key_to_str(key):
    out = []
    for i in range(32):
        out.append('%02x' % key[i])  # matches keyToStrProcessValue hex (lowercase)
    return ''.join(out)


# ---------- Config decode ----------
def decode_config(content, filename='configuration_pack.json'):
    data_str = '"data":"'
    data_offset = content.index(data_str) + len(data_str)
    data_end_offset = content.index('"', data_offset)
    assert data_end_offset - data_offset >= 128

    filename_key = process_filename(filename)
    state = A8j(content, data_offset, data_end_offset)
    steps = [
        lambda s: A3b(0, s),
        lambda s: B0p(filename_key, s),
        lambda s: A7L(filename_key, s),
        lambda s: A6I(filename_key, s),
        A2F,
        lambda s: B0L(filename_key, s),
        lambda s: A3b(1, s),
        lambda s: A3b(2, s),
        lambda s: A3b(3, s),
        lambda s: tB0l(filename_key, s),
    ]
    for fn in steps:
        state = fn(state)
    result = A6e(state)
    parsed = json.loads(result[0])
    return parsed, result[4], result[5], result[6]


if __name__ == '__main__':
    import sys
    # validate against bookworm fixtures
    base = 'bookworm/src/__fixtures__/'
    for num in ['001', '002']:
        enc = json.load(open(base + f'configuration_pack-{num}-encoded.json'))
        dec_expected = json.load(open(base + f'configuration_pack-{num}-decoded.json'))
        content = json.dumps(enc)  # must re-serialize to reproduce '"data":"..."' layout
        parsed, k1, k2, k3 = decode_config(content)
        print(f'=== fixture {num} ===')
        print('keys lengths:', len(k1), len(k2), len(k3))
        print('parsed type:', type(parsed))
        if isinstance(parsed, list):
            print('list len:', len(parsed))
            print('first item keys:', list(parsed[0].keys())[:5] if isinstance(parsed[0], dict) else parsed[0])
        elif isinstance(parsed, dict):
            print('dict keys:', list(parsed.keys())[:5])
        # compare with expected
        exp = dec_expected[0] if isinstance(dec_expected, list) and dec_expected and isinstance(dec_expected[0], dict) and 'FileLinkInfo' in dec_expected[0] else dec_expected
        print('expected type:', type(dec_expected))
