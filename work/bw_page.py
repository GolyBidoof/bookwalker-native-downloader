"""BookWalker page descramble: B2y PRNG + a3f tile-shuffle + A9p block-move script (Python port of bookworm)."""
import math

MASK32 = 0xFFFFFFFF

# B2y constants (verbatim from bookworm)
B2Y_TRIPLES = [
    [1,3,10],[1,5,16],[1,5,19],[1,9,29],[1,11,6],[1,11,16],[1,19,3],[1,21,20],[1,27,27],
    [2,5,15],[2,5,21],[2,7,7],[2,7,9],[2,7,25],[2,9,15],[2,15,17],[2,15,25],[2,21,9],
    [3,1,14],[3,3,26],[3,3,28],[3,3,29],[3,5,20],[3,5,22],[3,5,25],[3,7,29],[3,13,7],
    [3,23,25],[3,25,24],[3,27,11],[4,3,17],[4,3,27],[4,5,15],[5,3,21],[5,7,22],[5,9,7],
    [5,9,28],[5,9,31],[5,13,6],[5,15,17],[5,17,13],[5,21,12],[5,27,8],[5,27,21],[5,27,25],
    [5,27,28],[6,1,11],[6,3,17],[6,17,9],[6,21,7],[6,21,13],[7,1,9],[7,1,18],[7,1,25],
    [7,13,25],[7,17,21],[7,25,12],[7,25,20],[8,7,23],[8,9,23],[9,5,14],[9,5,25],[9,11,19],
    [9,21,16],[10,9,21],[10,9,25],[11,7,12],[11,7,16],[11,17,13],[11,21,13],[12,9,23],
    [13,3,17],[13,3,27],[13,5,19],[13,17,15],[14,1,15],[14,13,15],[15,1,29],[17,15,20],
    [17,15,23],[17,15,26],
]

def _xorshift_variant(p1, p2, p3, p4, variant):
    p1 &= MASK32
    if variant == 0:
        p1 ^= (p1 << p2) & MASK32; p1 ^= p1 >> p3; p1 ^= (p1 << p4) & MASK32
    elif variant == 1:
        p1 ^= (p1 << p4) & MASK32; p1 ^= p1 >> p3; p1 ^= (p1 << p2) & MASK32
    elif variant == 2:
        p1 ^= p1 >> p2; p1 ^= (p1 << p3) & MASK32; p1 ^= p1 >> p4
    elif variant == 3:
        p1 ^= p1 >> p4; p1 ^= (p1 << p3) & MASK32; p1 ^= p1 >> p2
    elif variant == 4:
        p1 ^= (p1 << p2) & MASK32; p1 ^= (p1 << p4) & MASK32; p1 ^= p1 >> p3
    else:
        p1 ^= p1 >> p2; p1 ^= p1 >> p4; p1 ^= (p1 << p3) & MASK32
    return p1 & MASK32

def _py_ror(x, n):
    # replicate JS >>> via masking
    return (x >> n) & MASK32 if n >= 0 else ((x << -n) & MASK32)

class B2y:
    b6o = len(B2Y_TRIPLES)      # 83
    b6b = 6                     # variants
    b4v = b6o * b6b             # 498

    def __init__(self):
        self.v_kgh = 0
        self.v_jgh = 2463534242
        self.v_lgh = B2Y_TRIPLES[74][self.v_kgh]
        self.v_kgh += 1
        self.v_mgh = B2Y_TRIPLES[74][self.v_kgh]
        self.v_kgh += 1
        self.v_ngh = B2Y_TRIPLES[74][self.v_kgh]
        self.v_kgh += 1
        self.v_ogh = 0  # variant fn index

    def b9es(self, E, L):
        self.v_jgh = 2463534242
        p = B2Y_TRIPLES[E]
        self.v_lgh, self.v_mgh, self.v_ngh = p[0], p[1], p[2]
        self.v_ogh = L

    def B0o(self, p1):
        r = p1 & MASK32
        self.v_jgh = r or 2463534242

    def b4K(self, p1):
        if p1 <= 1:
            return 0
        v_vgh = 4294967295 - p1
        ugh = self.v_jgh
        while True:
            ugh = _xorshift_variant(ugh, self.v_lgh, self.v_mgh, self.v_ngh, self.v_ogh) & MASK32
            tgh = ugh - 1
            sgh = tgh % p1
            if not (v_vgh < tgh - sgh):
                break
        self.v_jgh = ugh
        return sgh


def b4K_bound(fn, p1):
    return fn(p1)


# ---------- a3f ----------
def a3f(p1, p2, p3, p4):
    v_tog = B2y()
    v_uog = (p2 ^ p3 ^ p4) & MASK32
    v_vog = math.floor(p1 / 65536)
    v_wog = math.floor(p2 / 65536)
    v_xog = math.floor(p3 / 65536)
    v_yog = math.floor(p4 / 65536)
    v_zog = B2y.b6o
    v_0pg = B2y.b6b

    v_1pg = (v_wog ^ v_xog ^ v_yog) & MASK32
    v_2pg = (v_vog ^ v_yog) & MASK32
    v_3pg = (p1 ^ p2) & MASK32
    v_4pg = (p1 ^ p3) & MASK32
    v_5pg = (p1 ^ p4) & MASK32

    v_1pg = _py_ror(v_1pg, 16)  # >>> 16
    v_6pg = v_1pg % v_0pg
    v_7pg = ((v_1pg - v_6pg) / v_0pg) % v_zog

    b4k = v_tog.b4K

    v_tog.b9es(int(v_7pg), int(v_6pg))
    v_tog.B0o(v_uog)
    v_9pg = b4k(65536) | (b4k(65536) << 16)
    v_apg = b4k(512)
    v_bpg = v_wog >> 16
    v_cpg = v_xog >> 16

    v_2pg = ((v_2pg >> 16) ^ v_apg) & MASK32
    v_3pg = (v_3pg ^ v_9pg) & MASK32
    v_4pg = (v_4pg ^ v_9pg) & MASK32
    v_5pg = (v_5pg ^ v_9pg) & MASK32

    v_dpg = v_2pg % v_0pg
    v_epg = ((v_2pg - v_dpg) / v_0pg) % v_zog

    v_tog.b9es(int(v_epg), int(v_dpg))
    v_tog.B0o(v_3pg)
    v_fpg = v_mqg(b4k, v_bpg * v_cpg)
    v_tog.B0o(v_4pg)
    v_gpg = v_6qg(b4k, v_bpg)
    v_hpg = v_6qg(b4k, v_cpg)
    v_ipg = v_7qg(b4k, v_gpg, v_bpg)
    v_jpg = v_7qg(b4k, v_hpg, v_cpg)
    v_tog.B0o(v_5pg)
    v_kpg = Sparse()
    v_lpg = Sparse()
    v_9qg(b4k, v_kpg, v_lpg, v_gpg, v_hpg, v_bpg, v_cpg)
    v_mpg = v_mqg(b4k, v_bpg)
    v_npg = v_mqg(b4k, v_cpg)
    v_opg = Sparse()
    v_ppg = Sparse()
    v_9qg(b4k, v_ppg, v_opg, v_ipg, v_jpg, v_bpg, v_cpg)
    return v_qpg(v_bpg, v_cpg, v_fpg, v_mpg, v_npg, v_opg, v_ppg, v_ipg, v_jpg, v_lpg, v_kpg, v_gpg, v_hpg)


def v_mqg(fn, total):
    v_oqg = []
    for i in range(total):
        v_nqg = fn(i + 1)
        if v_nqg == i:
            v_oqg.append(i)
        else:
            v_oqg.append(v_oqg[v_nqg])
            v_oqg[v_nqg] = i
    return v_oqg


def v_6qg(fn, v):
    return fn(v + 1) if v < 4 else fn(v - 1) + 1


def v_7qg(fn, ye, ee):
    if ee <= 0:
        return 0
    v_8qg = fn(ee)
    return v_8qg if v_8qg < ye else v_8qg + 1


class _Undef:
    __slots__ = ()
    def __lt__(self, o): return False
    def __le__(self, o): return False
    def __gt__(self, o): return False
    def __ge__(self, o): return False
    def __eq__(self, o): return False
    def __ne__(self, o): return True
    def __bool__(self): return False

UNDEF = _Undef()

class Sparse(dict):
    """Emulate JS sparse array: missing index reads return UNDEF (falsy, comparisons False)."""
    def __getitem__(self, k):
        try:
            return super().__getitem__(k)
        except KeyError:
            return UNDEF
    def get(self, k, default=None):
        try:
            return super().__getitem__(k)
        except KeyError:
            return UNDEF


def v_9qg(fn, p2, p3, p4, p5, p6, p7):
    v_dqg = p6
    v_eqg = p7
    v_fqg = p4
    v_gqg = p5
    v_hqg = 0
    v_iqg = 0
    v_jqg = -1
    while v_dqg + v_eqg > 0:
        v_kqg = 0
        v_lqg = v_jqg
        v_aqg = fn(v_dqg + v_eqg)
        if v_aqg < v_dqg:
            if v_aqg < v_fqg:
                v_bqg = v_iqg
                while v_bqg > v_kqg and not (v_hqg >= p2[v_bqg + v_lqg]):
                    v_bqg -= 1
                v_cqg = v_iqg + v_eqg
                while v_cqg < p7 and not (v_hqg >= p2[v_cqg]):
                    v_cqg += 1
                p3[v_hqg] = fn(v_cqg - v_bqg) + v_bqg
                v_hqg += 1
                v_fqg -= 1
            else:
                v_bqg = v_iqg
                while v_bqg > v_kqg and not (v_hqg + v_dqg <= p2[v_bqg + v_lqg]):
                    v_bqg -= 1
                v_cqg = v_iqg + v_eqg
                while v_cqg < p7 and not (v_hqg + v_dqg <= p2[v_cqg]):
                    v_cqg += 1
                p3[v_hqg + v_dqg + v_lqg] = fn(v_cqg - v_bqg) + v_bqg
            v_dqg -= 1
        else:
            if v_aqg - v_dqg < v_gqg:
                v_bqg = v_hqg
                while v_bqg > v_kqg and not (v_iqg >= p3[v_bqg + v_lqg]):
                    v_bqg -= 1
                v_cqg = v_hqg + v_dqg
                while v_cqg < p6 and not (v_iqg >= p3[v_cqg]):
                    v_cqg += 1
                p2[v_iqg] = fn(v_cqg - v_bqg) + v_bqg
                v_iqg += 1
                v_gqg -= 1
            else:
                v_bqg = v_hqg
                while v_bqg > v_kqg and not (v_iqg + v_eqg <= p3[v_bqg + v_lqg]):
                    v_bqg -= 1
                v_cqg = v_hqg + v_dqg
                while v_cqg < p6 and not (v_iqg + v_eqg <= p3[v_cqg]):
                    v_cqg += 1
                p2[v_iqg + v_eqg + v_lqg] = fn(v_cqg - v_bqg) + v_bqg
            v_eqg -= 1


def v_qpg(p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13):
    result = []
    v_1qg = p1 + 1
    v_2qg = p2 + 1
    v_3qg = v_1qg << 1
    v_4qg = v_2qg << 1
    for v_vpg in range(p1):
        for v_wpg in range(p2):
            v_zpg = p3[v_vpg + v_wpg * p1]
            v_xpg = v_zpg % p1
            v_ypg = (v_zpg - v_xpg) // p1
            v_rpg = v_vpg if v_vpg < p11[v_wpg] else v_vpg + v_1qg
            v_spg = v_wpg if v_wpg < p10[v_vpg] else v_wpg + v_2qg
            v_tpg = v_xpg if v_xpg < p7[v_ypg] else v_xpg + v_1qg
            v_upg = v_ypg if v_ypg < p6[v_xpg] else v_ypg + v_2qg
            result.append(v_upg * v_3qg + v_rpg)
            result.append(v_tpg * v_4qg + v_spg)
    result.append(p9 * v_3qg + p12)
    result.append(p8 * v_4qg + p13)
    for v_vpg in range(p1):
        v_xpg = p4[v_vpg]
        v_rpg = v_vpg if v_vpg < p12 else v_vpg + v_1qg
        v_tpg = v_xpg if v_xpg < p8 else v_xpg + v_1qg
        result.append(p6[v_xpg] * v_3qg + v_rpg)
        result.append(v_tpg * v_4qg + p10[v_vpg])
    for v_wpg in range(p2):
        v_ypg = p5[v_wpg]
        v_spg = v_wpg if v_wpg < p13 else v_wpg + v_2qg
        v_upg = v_ypg if v_ypg < p9 else v_ypg + v_2qg
        result.append(v_upg * v_3qg + p11[v_wpg])
        result.append(p7[v_ypg] * v_4qg + v_spg)
    return result


# ---------- A9p: block-move script ----------
def A9p(page, width, height):
    block_width = page['b8A']
    block_height = page['b6V']
    v_r3j = page['B0J']
    v_s3j = page['B0K']
    v_t3j = page['B0n']
    v_u3j = page['B0A']
    v_v3j = B2y.b6o
    v_w3j = B2y.b6b
    blocks_x = math.floor(width / block_width)
    blocks_y = math.floor(height / block_height)
    last_block_width = width % block_width
    last_block_height = height % block_height
    v_14j = (blocks_x + 1) << 1
    v_24j = (blocks_y + 1) << 1
    last_block_xvs = (blocks_x + 1) * block_width - last_block_width
    last_block_yvs = (blocks_y + 1) * block_height - last_block_height
    v_54j = B2y()
    v_64j = (v_u3j ^ blocks_x ^ blocks_y) & MASK32
    v_74j = v_64j % v_w3j
    v_84j = ((v_64j - v_74j) / v_w3j) % v_v3j
    v_o3j = []
    v_54j.b9es(int(v_84j), int(v_74j))
    v_54j.B0o((v_r3j ^ v_s3j ^ v_t3j) & MASK32)
    v_94j = b4K_bound(v_54j.b4K, 65536) + b4K_bound(v_54j.b4K, 65536) * 65536 + b4K_bound(v_54j.b4K, 512) * 4294967296

    v_a4j = blocks_x * 4294967296 + v_r3j
    v_b4j = blocks_y * 4294967296 + v_s3j
    v_c4j = v_u3j * 4294967296 + v_t3j
    v_d4j = a3f(v_94j, v_a4j, v_b4j, v_c4j)

    def v_e4j(index, total, step_bw, step_bh):
        if step_bw != 0 and step_bh != 0:
            while index < total:
                v_f4j = v_d4j[index]
                index += 1
                v_g4j = v_d4j[index]
                index += 1
                v_h4j = v_f4j % v_14j
                v_i4j = v_g4j % v_24j
                v_j4j = (v_g4j - v_i4j) // v_24j
                v_k4j = (v_f4j - v_h4j) // v_14j
                v_o3j.append({
                    'srcX': v_h4j * block_width - (last_block_xvs if v_h4j > blocks_x else 0),
                    'srcY': v_i4j * block_height - (last_block_yvs if v_i4j > blocks_y else 0),
                    'destX': v_j4j * block_width - (last_block_xvs if v_j4j > blocks_x else 0),
                    'destY': v_k4j * block_height - (last_block_yvs if v_k4j > blocks_y else 0),
                    'width': step_bw,
                    'height': step_bh,
                })

    v_x4j = 0
    v_y4j = blocks_x * blocks_y * 2
    v_e4j(v_x4j, v_y4j, block_width, block_height)
    v_x4j = v_y4j
    v_y4j += 2
    v_e4j(v_x4j, v_y4j, last_block_width, last_block_height)
    v_x4j = v_y4j
    v_y4j += blocks_x * 2
    v_e4j(v_x4j, v_y4j, block_width, last_block_height)
    v_x4j = v_y4j
    v_y4j += blocks_y * 2
    v_e4j(v_x4j, v_y4j, last_block_width, block_height)
    return v_o3j


if __name__ == '__main__':
    import json
    fx = json.load(open('bookworm/src/exported/__fixtures__/A9p-001.json'))
    page, w, h = fx['input'][0], fx['input'][1], fx['input'][2]
    out = A9p(page, w, h)
    exp = fx['output']
    print('tiles:', len(out), 'expected:', len(exp))
    mism = 0
    for a, b in zip(out, exp):
        if a != b:
            mism += 1
            if mism <= 5:
                print('MISMATCH', a, b)
    print('mismatches:', mism)


# ---------- Page seeds (bookworm Page.ts) ----------
def page_seeds(page_id: str, page_config, key1, key2, key3):
    """Compute B0A/B0J/B0K/B0n + BlockWidth/Height for a page config dict."""
    page = page_config['FileLinkInfo']['PageLinkInfoList'][0]['Page']
    NS = page['NS']
    PS = page['PS']
    RS = page['RS']
    No = page['No']

    v_0if = 47
    for ch in page_id:
        v_0if += ord(ch)
    fname = str(No)
    for ch in fname:
        v_0if += ord(ch)
    v_0if += sum(key1) + sum(key2) + sum(key3)

    v_9if = v_0if & 255
    v_9if |= v_9if << 8
    v_9if |= v_9if << 16

    def v_mhf(k):
        v_nhf = 0
        v_ohf = len(k) & -4
        if v_ohf > 32:
            v_ohf = 32
        v_phf = 0
        while v_phf < v_ohf:
            v_nhf ^= k[v_phf] << 24
            v_phf += 1
            v_nhf ^= k[v_phf] << 16
            v_phf += 1
            v_nhf ^= k[v_phf] << 8
            v_phf += 1
            v_nhf ^= k[v_phf] << 0
            v_phf += 1
        return v_nhf & MASK32

    return {
        'B0A': v_0if % B2y.b4v,
        'B0J': (v_9if ^ v_mhf(key1) ^ NS) & MASK32,
        'B0K': (v_9if ^ v_mhf(key2) ^ PS) & MASK32,
        'B0n': (v_9if ^ v_mhf(key3) ^ RS) & MASK32,
        'b8A': page['BlockWidth'],
        'b6V': page['BlockHeight'],
        'Size': page.get('Size'),
    }
