"""スマホに Claude の APIキーを入れるための QR コードを、この窓に出す

「スマホにAPIキーを入れる.bat」をダブルクリックすると、これが動く。
スマホのカメラで読むとゲームのページが開き、キーがスマホの中に保存される。
QR コードにはキーがそのまま入っているので、画像には保存せず、この窓に出すだけにする。
読み取ったら、すぐにこの窓を閉じること。
"""

import sys
import urllib.parse

from launch import read_env


def main():
    values = read_env()
    key = values.get("ANTHROPIC_API_KEY", "")
    page = values.get("JINRO_PAGE_URL", "")
    if not key.startswith("sk-"):
        print(".env に ANTHROPIC_API_KEY が見つかりません。")
        return 1
    if not page:
        print(".env に JINRO_PAGE_URL（ゲームのページ）が見つかりません。")
        return 1
    try:
        import qrcode
    except ImportError:
        print("qrcode が入っていません。pip install qrcode で入れてください。")
        return 1
    url = f"{page}#k={urllib.parse.quote(key, safe='')}"
    print("スマホのカメラでこの QR コードを読んでください。")
    print("ゲームのページが開いて、APIキーが入ります。")
    print()
    qr = qrcode.QRCode(border=2, error_correction=qrcode.constants.ERROR_CORRECT_L)
    qr.add_data(url)
    qr.print_ascii(invert=True)
    print()
    print("※ この QR コードには APIキーが入っています。読み取ったら、すぐにこの窓を閉じてください。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
