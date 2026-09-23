FROM python:3.12.9-slim@sha256:48a11b7ba705fd53bf15248d1f94d36c39549903c5d59edcfa2f3f84126e7b44
WORKDIR /proof
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --requirement requirements.txt
CMD ["python", "/proof/proof.py"]
